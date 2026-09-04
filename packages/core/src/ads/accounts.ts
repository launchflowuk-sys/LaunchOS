import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

/**
 * A well-formed ISO-4217 code, and nothing else.
 *
 * `length(3)` accepted `12X`, `G B` and `£$€`. The value is stored verbatim on
 * `ad_accounts.currency` and later handed to `Intl.NumberFormat`, which throws
 * `RangeError` for anything that is not `[A-Za-z]{3}` — one typo in the add
 * form and every render of `/ads` (which formats *every* account in one table)
 * is a 500 with no way back through the UI. The screens guard their formatting
 * too, but this is the boundary that stops the bad value being written at all,
 * and it covers the agent tools and the seed as well as the form.
 *
 * Unknown-but-well-formed codes are deliberately allowed: `Intl` renders those
 * as "ABC 1.00" rather than throwing, and a hard-coded list of live codes would
 * be wrong the first time a currency is added.
 */
export const CurrencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a three-letter code");

export const CreateAdAccountInput = z.object({
  clientId: z.string().uuid(),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().min(1),
  name: z.string().min(1),
  currency: CurrencyCode.default("GBP"),
  status: z.enum(["active", "paused", "disconnected"]).default("active"),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateAdAccountInput = z.input<typeof CreateAdAccountInput>;

/**
 * Postgres `unique_violation`. Drizzle wraps the driver's `PostgresError` in a
 * `DrizzleQueryError`, so the `23505` code can be on the error itself or one
 * level down on `.cause`.
 */
function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === "23505" || errorCode((error as { cause?: unknown })?.cause) === "23505";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
}

const platformLabel = (platform: "google" | "meta") => (platform === "google" ? "Google" : "Meta");

export async function createAdAccount(db: Db, organisationId: string, input: CreateAdAccountInput) {
  const v = CreateAdAccountInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  try {
    return await db.transaction(async (tx) => {
      const inner = tx as unknown as Db;
      const [account] = await tx.insert(schema.adAccounts).values({
        organisationId,
        clientId: v.clientId,
        platform: v.platform,
        externalId: v.externalId,
        name: v.name,
        currency: v.currency,
        status: v.status,
      }).returning();
      await recordAudit(inner, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "ad_account.created",
        targetType: "ad_account", targetId: account!.id, after: account,
      });
      await recordActivity(inner, organisationId, {
        clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "ad_account.created",
        title: `${platformLabel(v.platform)} ads account connected: ${v.name}`,
        link: `/ads/${account!.id}`,
      });
      return account!;
    });
  } catch (error) {
    // `ad_accounts_org_platform_external` is the most likely failure of the add
    // form — the list gives no hint which external ids are already connected.
    // The raw constraint name is unactionable and leaks the schema into a toast.
    if (isUniqueViolation(error)) {
      throw new Error(`That ${platformLabel(v.platform)} account (${v.externalId}) is already connected.`);
    }
    throw error;
  }
}

export const UpdateAdAccountInput = z.object({
  adAccountId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  currency: CurrencyCode.optional(),
  status: z.enum(["active", "paused", "disconnected"]).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type UpdateAdAccountInput = z.input<typeof UpdateAdAccountInput>;

/**
 * Corrects an account's name, currency or status.
 *
 * The platform and the external id are the account's identity — the unique key
 * the ingest matches on — so they are not editable here; a wrong one is a new
 * account, not an edit. Currency is: before this existed, a bad currency could
 * only be fixed with an `UPDATE` against production Postgres.
 */
export async function updateAdAccount(db: Db, organisationId: string, input: UpdateAdAccountInput) {
  const v = UpdateAdAccountInput.parse(input);
  const patch = {
    ...(v.name === undefined ? {} : { name: v.name }),
    ...(v.currency === undefined ? {} : { currency: v.currency }),
    ...(v.status === undefined ? {} : { status: v.status }),
  };
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change on this ad account");

  await assertOwned(db, organisationId, schema.adAccounts, v.adAccountId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const scope = and(
      eq(schema.adAccounts.id, v.adAccountId),
      eq(schema.adAccounts.organisationId, organisationId),
      isNull(schema.adAccounts.deletedAt),
    );
    const [before] = await tx.select().from(schema.adAccounts).where(scope);
    if (!before) throw new Error(`ad account ${v.adAccountId} not found in organisation`);

    // `assertOwned` above already refused another organisation's account; the
    // predicate here is so the statement self-guards, per CLAUDE.md rule 1.
    const [after] = await tx.update(schema.adAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(scope)
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "ad_account.updated",
      targetType: "ad_account", targetId: v.adAccountId, before, after,
    });
    return after!;
  });
}

export interface AdAccountRow {
  id: string;
  clientId: string;
  clientName: string;
  platform: "google" | "meta";
  externalId: string;
  name: string;
  currency: string;
  status: "active" | "paused" | "disconnected";
}

/** Unbounded listings do not exist here: a caller that wants more asks for more. */
const DEFAULT_AD_ACCOUNT_LIMIT = 200;

export async function listAdAccounts(
  db: Db,
  organisationId: string,
  filter: {
    clientId?: string;
    status?: "active" | "paused" | "disconnected";
    limit?: number;
  } = {},
): Promise<AdAccountRow[]> {
  const where = [
    eq(schema.adAccounts.organisationId, organisationId),
    isNull(schema.adAccounts.deletedAt),
    ...(filter.clientId ? [eq(schema.adAccounts.clientId, filter.clientId)] : []),
    ...(filter.status ? [eq(schema.adAccounts.status, filter.status)] : []),
  ];
  return db.select({
    id: schema.adAccounts.id,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
    platform: schema.adAccounts.platform,
    externalId: schema.adAccounts.externalId,
    name: schema.adAccounts.name,
    currency: schema.adAccounts.currency,
    status: schema.adAccounts.status,
  })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(...where))
    .orderBy(schema.clients.name, schema.adAccounts.name)
    .limit(filter.limit ?? DEFAULT_AD_ACCOUNT_LIMIT);
}
