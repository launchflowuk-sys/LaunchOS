import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { PERMISSION_KEYS } from "../team/permissions.js";
import { generateApiToken } from "./token.js";

export const IssueApiTokenInput = z.object({
  name: z.string().trim().min(1, "give the token a name so you can tell it apart later").max(120),
  /** Empty means it can read nothing, which is useless but honest. Nothing here grants a write. */
  scopes: z.array(z.enum(PERMISSION_KEYS)).default([]),
  /** Null or absent means it does not expire. */
  expiresAt: z.date().nullish(),
  actorId: z.string().optional(),
});
export type IssueApiTokenInput = z.input<typeof IssueApiTokenInput>;

export interface IssuedApiToken {
  /**
   * The token itself. **This is the only time it exists in readable form.**
   * Nothing stores it, the audit row does not contain it, and the list
   * endpoint cannot reproduce it. A caller that loses it issues another.
   */
  readonly token: string;
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Mint a key for something outside this repository — Mr. Green first.
 *
 * The audit row records that a token was created, by whom, under what name and
 * with which scopes. It records neither the token nor its hash: an audit log is
 * read by more people and kept for longer than the thing it describes, and a
 * secret in it is a secret in all of those places.
 */
export async function issueApiToken(db: Db, organisationId: string, input: IssueApiTokenInput): Promise<IssuedApiToken> {
  const v = IssueApiTokenInput.parse(input);
  const { token, tokenHash, prefix } = generateApiToken();

  const [row] = await db
    .insert(schema.apiTokens)
    .values({
      organisationId,
      name: v.name,
      tokenHash,
      prefix,
      scopes: [...v.scopes],
      expiresAt: v.expiresAt ?? null,
      createdByUserId: v.actorId ?? null,
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.actorId,
    action: "api_token.issued",
    targetType: "api_token",
    targetId: row!.id,
    after: { name: row!.name, prefix: row!.prefix, scopes: row!.scopes, expiresAt: row!.expiresAt },
  });

  return {
    token,
    id: row!.id,
    name: row!.name,
    prefix: row!.prefix,
    scopes: row!.scopes,
    expiresAt: row!.expiresAt,
    createdAt: row!.createdAt,
  };
}
