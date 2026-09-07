import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import type { PermissionKey } from "../team/permissions.js";
import { hashApiToken, looksLikeApiToken } from "./token.js";

export interface VerifiedApiToken {
  readonly tokenId: string;
  readonly organisationId: string;
  readonly name: string;
  readonly scopes: readonly PermissionKey[];
}

/**
 * Stamped at most this often. A read-only API called in a loop should not
 * generate one row update per request for a column nobody reads to the second.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Turn a bearer token into the organisation it speaks for, or null.
 *
 * **This is the one function in `core` that does not take an `organisationId`,
 * and it is not an oversight.** The token is *how* the organisation is
 * discovered; asking the caller to supply one would mean the caller had already
 * decided, which is exactly the decision that must not be theirs to make.
 * Everything it hands off to still takes the organisation it returns, so rule 1
 * holds from here on.
 *
 * Null covers every failure — unknown, revoked, expired, malformed — and the
 * caller must answer 401 for all of them without distinguishing. Telling the
 * holder of a dead token that it was once real is telling them something they
 * would otherwise have to guess.
 */
export async function verifyApiToken(db: Db, token: string, now: Date = new Date()): Promise<VerifiedApiToken | null> {
  // Nothing shaped wrong reaches the database: a stray session cookie or a
  // bearer from another system is rejected here rather than logged as a query.
  if (!looksLikeApiToken(token)) return null;

  const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hashApiToken(token))).limit(1);
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.deletedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;

  await stampLastUsed(db, row.id, row.lastUsedAt, now);

  return {
    tokenId: row.id,
    organisationId: row.organisationId,
    name: row.name,
    scopes: row.scopes as PermissionKey[],
  };
}

/**
 * Best effort, and deliberately so: a token that works must not stop working
 * because the column recording that it worked could not be written.
 */
async function stampLastUsed(db: Db, id: string, lastUsedAt: Date | null, now: Date): Promise<void> {
  if (lastUsedAt !== null && now.getTime() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return;
  try {
    await db.update(schema.apiTokens).set({ lastUsedAt: now }).where(eq(schema.apiTokens.id, id));
  } catch {
    // Swallowed on purpose. This is the one place in the codebase where losing
    // a write is preferable to failing the request that caused it.
  }
}
