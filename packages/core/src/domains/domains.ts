import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { aliasedTable, and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { escapeLike } from "../clients/list-clients.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

// Hostnames only: no scheme, no path, no trailing dot.
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const CreateDomainInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().toLowerCase().max(253).regex(HOSTNAME),
  siteId: z.string().uuid().optional(),
  registrar: z.string().max(100).optional(),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).default("other"),
  nameservers: z.array(z.string().max(253)).max(10).default([]),
  expiresAt: z.coerce.date().optional(),
  autoRenew: z.boolean().default(true),
  notes: z.string().max(4000).optional(),
  ...ACTOR,
});
export type CreateDomainInput = z.input<typeof CreateDomainInput>;

export async function createDomain(db: Db, organisationId: string, input: CreateDomainInput) {
  const { actorKind, actorId, ...fields } = CreateDomainInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, fields.clientId);
  if (fields.siteId) await assertOwned(db, organisationId, schema.sites, fields.siteId);

  // Checked explicitly so the UI gets a sentence rather than a unique-index error.
  const [clash] = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.name, fields.name)));
  if (clash) throw new Error(`domain ${fields.name} already exists`);

  const domain = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [row] = await tx.insert(schema.domains).values({ organisationId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId: fields.clientId, siteId: fields.siteId, actorKind, actorId, kind: "domain.created",
      title: `Domain added: ${row!.name}`, link: `/domains/${row!.id}`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "domain.created", targetType: "domain", targetId: row!.id, after: row,
    });
    return row!;
  });

  await emit({ name: "domain.created", organisationId, domainId: domain.id });
  return domain;
}

export const UpdateDomainInput = z.object({
  domainId: z.string().uuid(),
  siteId: z.string().uuid().nullish(),
  registrar: z.string().max(100).nullish(),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).optional(),
  nameservers: z.array(z.string().max(253)).max(10).optional(),
  expiresAt: z.coerce.date().nullish(),
  autoRenew: z.boolean().optional(),
  status: z.enum(["active", "expiring", "expired", "transferring"]).optional(),
  notes: z.string().max(4000).nullish(),
  ...ACTOR,
});
export type UpdateDomainInput = z.input<typeof UpdateDomainInput>;

export async function updateDomain(db: Db, organisationId: string, input: UpdateDomainInput) {
  const { domainId, actorKind, actorId, ...patch } = UpdateDomainInput.parse(input);
  if (patch.siteId) await assertOwned(db, organisationId, schema.sites, patch.siteId);
  const where = and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.domains).where(where);
    if (!before) throw new Error(`domain ${domainId} not found in organisation`);
    const [after] = await tx.update(schema.domains).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "domain.updated", targetType: "domain", targetId: domainId, before, after,
    });
    return after!;
  });
}

export const DeleteDomainInput = z.object({ domainId: z.string().uuid(), ...ACTOR });
export type DeleteDomainInput = z.input<typeof DeleteDomainInput>;

export async function deleteDomain(db: Db, organisationId: string, input: DeleteDomainInput): Promise<void> {
  const { domainId, actorKind, actorId } = DeleteDomainInput.parse(input);
  const where = and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.domains).where(where);
    if (!before) throw new Error(`domain ${domainId} not found in organisation`);
    await tx.delete(schema.domains).where(where); // dns_records cascade
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "domain.deleted", targetType: "domain", targetId: domainId, before,
    });
  });
}

export const ListDomainsInput = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  query: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(300).default(200),
});
export type ListDomainsInput = z.input<typeof ListDomainsInput>;

export type DomainListRow = {
  id: string;
  name: string;
  status: "active" | "expiring" | "expired" | "transferring";
  dnsProvider: "cloudflare" | "registrar" | "other";
  registrar: string | null;
  expiresAt: Date | null;
  clientId: string;
  clientName: string;
  siteId: string | null;
  siteName: string | null;
};

export async function listDomains(db: Db, organisationId: string, input: ListDomainsInput = {}): Promise<DomainListRow[]> {
  const v = ListDomainsInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;
  const site = aliasedTable(schema.sites, "domain_site");

  return db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      status: schema.domains.status,
      dnsProvider: schema.domains.dnsProvider,
      registrar: schema.domains.registrar,
      expiresAt: schema.domains.expiresAt,
      clientId: schema.domains.clientId,
      clientName: schema.clients.name,
      siteId: schema.domains.siteId,
      siteName: site.name,
    })
    .from(schema.domains)
    .innerJoin(schema.clients, eq(schema.domains.clientId, schema.clients.id))
    .leftJoin(site, eq(schema.domains.siteId, site.id))
    .where(
      and(
        eq(schema.domains.organisationId, organisationId),
        v.clientId ? eq(schema.domains.clientId, v.clientId) : undefined,
        v.siteId ? eq(schema.domains.siteId, v.siteId) : undefined,
        term ? or(ilike(schema.domains.name, term), ilike(schema.domains.registrar, term)) : undefined,
      ),
    )
    .orderBy(asc(schema.domains.name))
    .limit(v.limit);
}

export async function getDomain(db: Db, organisationId: string, domainId: string) {
  const [row] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.organisationId, organisationId)));
  return row ?? null;
}
