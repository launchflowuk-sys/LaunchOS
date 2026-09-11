import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientService, ContentChannel, PackageIncludes, TaskKind } from "@launchos/db/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

/**
 * Which of a client's services are switched on.
 *
 * The rule the whole module exists to hold: **paying for something does not
 * switch it on; a person does.** Every job that spends money on a client — the
 * content planner and writer, publishing, blog fan-out, ad ingest, the ad
 * Sentinel, recurring service tasks — asks here first. A client nobody has
 * switched on gets their website and nothing else, which is the safe side to
 * be wrong on: a missed post is a conversation, a month of posts and ad
 * reports nobody paid for is tokens and hours that do not come back.
 */

export const CLIENT_SERVICES: readonly ClientService[] = schema.clientServiceEnum.enumValues;

/** The services that produce posts. Planning, drafting and briefs need at least one. */
export const CONTENT_SERVICES: readonly ClientService[] = ["blog", "social", "gbp"];

export const SERVICE_LABEL: Readonly<Record<ClientService, string>> = {
  ads: "Ads management",
  blog: "Blog posts",
  social: "Social posts",
  gbp: "Google Business updates",
};

/** Facebook and Instagram are one service: the package sells social posts, not platforms. */
export const SERVICE_FOR_CHANNEL: Readonly<Record<ContentChannel, ClientService>> = {
  facebook: "social",
  instagram: "social",
  blog: "blog",
  gbp: "gbp",
};

/** The recurring task kinds that are service work. Anything else (SEO, support, billing) is not gated here. */
export const SERVICE_FOR_TASK_KIND: Readonly<Partial<Record<TaskKind, ClientService>>> = {
  social: "social",
  content: "blog",
  gbp: "gbp",
};

/** What a package sells — the advice a person weighs, never the switch itself. */
export function servicesPaidFor(includes: PackageIncludes): ReadonlySet<ClientService> {
  const paid = new Set<ClientService>();
  if (includes.ads) paid.add("ads");
  if (includes.blogPostsPerMonth > 0) paid.add("blog");
  if (includes.socialPostsPerMonth > 0) paid.add("social");
  if (includes.gbpUpdatesPerMonth > 0) paid.add("gbp");
  return paid;
}

/** The package as far as the switched-on services reach: every other quota reads as zero. */
export function includesForServices(includes: PackageIncludes, active: ReadonlySet<ClientService>): PackageIncludes {
  return {
    ...includes,
    ads: includes.ads && active.has("ads"),
    blogPostsPerMonth: active.has("blog") ? includes.blogPostsPerMonth : 0,
    socialPostsPerMonth: active.has("social") ? includes.socialPostsPerMonth : 0,
    gbpUpdatesPerMonth: active.has("gbp") ? includes.gbpUpdatesPerMonth : 0,
  };
}

/** True when any content service is on. */
export function hasContentService(active: ReadonlySet<ClientService>): boolean {
  return CONTENT_SERVICES.some((service) => active.has(service));
}

function liveRow(organisationId: string) {
  return and(
    eq(schema.clientServices.organisationId, organisationId),
    eq(schema.clientServices.active, true),
    isNull(schema.clientServices.deletedAt),
  );
}

export async function activeServicesForClient(db: Db, organisationId: string, clientId: string): Promise<ReadonlySet<ClientService>> {
  const rows = await db.select({ service: schema.clientServices.service })
    .from(schema.clientServices)
    .where(and(liveRow(organisationId), eq(schema.clientServices.clientId, clientId)));
  return new Set(rows.map((row) => row.service));
}

/** Every client's switched-on services in one read, for a sweep across the organisation. */
export async function activeServicesByClient(db: Db, organisationId: string): Promise<ReadonlyMap<string, ReadonlySet<ClientService>>> {
  const rows = await db.select({ clientId: schema.clientServices.clientId, service: schema.clientServices.service })
    .from(schema.clientServices)
    .where(liveRow(organisationId));
  const byClient = new Map<string, Set<ClientService>>();
  for (const row of rows) byClient.set(row.clientId, new Set([...(byClient.get(row.clientId) ?? []), row.service]));
  return byClient;
}

export async function clientIdsWithService(db: Db, organisationId: string, service: ClientService): Promise<ReadonlySet<string>> {
  const rows = await db.select({ clientId: schema.clientServices.clientId })
    .from(schema.clientServices)
    .where(and(liveRow(organisationId), eq(schema.clientServices.service, service)));
  return new Set(rows.map((row) => row.clientId));
}

/**
 * `exists (…)` for "this row's client has the service on", for a sweep that has
 * to filter in SQL — a claim under `FOR UPDATE`, or a listing with a limit,
 * where filtering afterwards would hand back fewer rows than asked for.
 *
 * `service` is either a fixed service or an expression over the outer row, such
 * as `serviceForChannelSql` for a content item.
 */
export function serviceActiveSql(organisationId: string, clientIdColumn: AnyColumn, service: ClientService | SQL): SQL {
  const wanted = typeof service === "string" ? sql`${service}::client_service` : service;
  return sql`exists (
    select 1 from client_services cs
    where cs.organisation_id = ${organisationId}
      and cs.client_id = ${clientIdColumn}
      and cs.service = ${wanted}
      and cs.active
      and cs.deleted_at is null
  )`;
}

/** `SERVICE_FOR_CHANNEL`, as SQL over a `content_channel` column. */
export function serviceForChannelSql(channelColumn: AnyColumn): SQL {
  return sql`(case ${channelColumn}
    when 'facebook' then 'social'
    when 'instagram' then 'social'
    when 'blog' then 'blog'
    when 'gbp' then 'gbp'
  end)::client_service`;
}

export interface ClientServiceState {
  service: ClientService;
  active: boolean;
  /** Null for a switch nobody has ever touched. */
  changedAt: Date | null;
  changedByUserId: string | null;
  changedByName: string | null;
}

/** One entry per service, in `CLIENT_SERVICES` order, including the ones with no row yet. */
export async function listClientServices(db: Db, organisationId: string, clientId: string): Promise<ClientServiceState[]> {
  const rows = await db.select({
    service: schema.clientServices.service,
    active: schema.clientServices.active,
    changedAt: schema.clientServices.changedAt,
    changedByUserId: schema.clientServices.changedByUserId,
    changedByName: schema.user.name,
  })
    .from(schema.clientServices)
    .leftJoin(schema.user, eq(schema.user.id, schema.clientServices.changedByUserId))
    .where(and(
      eq(schema.clientServices.organisationId, organisationId),
      eq(schema.clientServices.clientId, clientId),
      isNull(schema.clientServices.deletedAt),
    ));
  const byService = new Map(rows.map((row) => [row.service, row]));
  return CLIENT_SERVICES.map((service) => {
    const row = byService.get(service);
    return {
      service,
      active: row?.active ?? false,
      changedAt: row?.changedAt ?? null,
      changedByUserId: row?.changedByUserId ?? null,
      changedByName: row?.changedByName ?? null,
    };
  });
}

export const SetClientServiceInput = z.object({
  clientId: z.string().uuid(),
  service: z.enum(schema.clientServiceEnum.enumValues),
  active: z.boolean(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().min(1).optional(),
});
export type SetClientServiceInput = z.input<typeof SetClientServiceInput>;

/**
 * Moves one switch. Audited and put on the client's timeline when it actually
 * moves, because "who turned their posting off, and when" is the question this
 * record exists to answer. Asking for the state it is already in records
 * nothing: a double-click is not a decision.
 *
 * Switching off holds work rather than destroying it. Nothing here cancels a
 * post or an ad account; the jobs simply stop picking them up, and switching
 * back on carries on from where they were.
 */
export async function setClientService(
  db: Db,
  organisationId: string,
  input: SetClientServiceInput,
): Promise<{ changed: boolean; active: boolean }> {
  const v = SetClientServiceInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // `FOR UPDATE` locks nothing when the switch has never been touched, so two
    // people flipping a brand-new switch at once would both read "off" and one
    // decision could vanish. The advisory lock serialises every toggle of this
    // one switch, row or no row, and is released when the transaction ends.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`client_service:${organisationId}:${v.clientId}:${v.service}`}))`);
    const scope = and(
      eq(schema.clientServices.organisationId, organisationId),
      eq(schema.clientServices.clientId, v.clientId),
      eq(schema.clientServices.service, v.service),
    );
    const [before] = await tx.select().from(schema.clientServices).where(scope).for("update");
    const wasActive = Boolean(before?.active && !before.deletedAt);
    if (wasActive === v.active) return { changed: false, active: v.active };

    const now = new Date();
    const changedByUserId = v.actorKind === "user" ? v.actorId ?? null : null;
    const [after] = await tx.insert(schema.clientServices)
      .values({ organisationId, clientId: v.clientId, service: v.service, active: v.active, changedAt: now, changedByUserId })
      .onConflictDoUpdate({
        target: [schema.clientServices.organisationId, schema.clientServices.clientId, schema.clientServices.service],
        set: { active: v.active, changedAt: now, changedByUserId, deletedAt: null, updatedAt: now },
      })
      .returning();

    const verb = v.active ? "activated" : "deactivated";
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: `client_service.${verb}`,
      targetType: "client_service", targetId: after!.id, before: before ?? null, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: `client_service.${verb}`,
      title: `${SERVICE_LABEL[v.service]} switched ${v.active ? "on" : "off"}`,
      link: `/clients/${v.clientId}/services`,
    });
    return { changed: true, active: v.active };
  });
}
