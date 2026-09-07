import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PermissionKey } from "../team/permissions.js";

export interface ApiTokenRow {
  readonly id: string;
  readonly name: string;
  /** Enough to recognise the row. Never enough to use. */
  readonly prefix: string;
  readonly scopes: readonly PermissionKey[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  /** Whether it would work right now — revoked or past its expiry both read false. */
  readonly active: boolean;
}

/**
 * Every token this organisation has issued, newest first, revoked ones
 * included.
 *
 * Revoked rows stay in the list rather than vanishing, because the question a
 * person asks here is usually "did I already kill that one?" and an empty space
 * does not answer it. `token_hash` is not selected: there is no screen, export
 * or log that has any use for it.
 */
export async function listApiTokens(db: Db, organisationId: string, now: Date = new Date()): Promise<ApiTokenRow[]> {
  const rows = await db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      prefix: schema.apiTokens.prefix,
      scopes: schema.apiTokens.scopes,
      createdAt: schema.apiTokens.createdAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      expiresAt: schema.apiTokens.expiresAt,
      revokedAt: schema.apiTokens.revokedAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.organisationId, organisationId), isNull(schema.apiTokens.deletedAt)))
    // `created_at` defaults to `now()`, which in Postgres is the *transaction's*
    // start time, not the statement's — so two tokens issued in one transaction
    // carry the identical timestamp and sorting on it alone leaves their order
    // to the planner. The list then reshuffles between reloads for no reason a
    // reader can see. The id is the tiebreak: arbitrary, but the same arbitrary
    // every time.
    .orderBy(desc(schema.apiTokens.createdAt), desc(schema.apiTokens.id));

  return rows.map((row) => ({
    ...row,
    scopes: row.scopes as PermissionKey[],
    active: row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
  }));
}
