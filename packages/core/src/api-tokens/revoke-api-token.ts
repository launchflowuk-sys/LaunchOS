import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";

export interface RevokeApiTokenInput {
  readonly id: string;
  readonly actorId?: string;
}

/**
 * Kill a token, now, without a deploy.
 *
 * That is the whole reason this is a table rather than an environment
 * variable: a laptop goes missing on a Tuesday and the key stops working on
 * Tuesday, not whenever a container next rebuilds.
 *
 * The row is kept and stamped rather than deleted, so the audit trail still
 * resolves to something — an entry pointing at a vanished id tells you a token
 * did something but not which one.
 *
 * Scoped by organisation as well as by id: without that, an id guessed or
 * leaked from another tenant would be revocable from here, which is the
 * cross-tenant write rule 1 exists to prevent.
 */
export async function revokeApiToken(db: Db, organisationId: string, input: RevokeApiTokenInput): Promise<boolean> {
  const [row] = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.apiTokens.id, input.id),
        eq(schema.apiTokens.organisationId, organisationId),
        isNull(schema.apiTokens.revokedAt),
      ),
    )
    .returning();

  // Already revoked, or never this organisation's. Neither is an error worth
  // raising — the caller wanted it dead and it is dead — but nothing is
  // audited, because nothing happened.
  if (!row) return false;

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: input.actorId,
    action: "api_token.revoked",
    targetType: "api_token",
    targetId: row.id,
    after: { name: row.name, prefix: row.prefix, revokedAt: row.revokedAt },
  });

  return true;
}
