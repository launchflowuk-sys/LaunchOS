import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { decryptSecret, loadEncryptionKey } from "../secrets/encryption.js";
import { ACCESS_TARGET_TYPE, getStoredEntry } from "./access-entries.js";

export const RevealAccessSecretInput = z.object({
  entryId: z.string().uuid(),
  /** Who is looking. Required: an anonymous reveal is exactly what the audit exists to rule out. */
  actorId: z.string().min(1),
  actorKind: z.enum(["user", "agent", "system"]).default("user"),
});
export type RevealAccessSecretInput = z.input<typeof RevealAccessSecretInput>;

export interface RevealedAccessSecret {
  readonly secret: string;
  readonly label: string;
  /** The client the entry really belongs to — the caller revalidates from this, not from its form. */
  readonly clientId: string;
  readonly lastViewedAt: Date;
}

/**
 * The one door out for a stored password.
 *
 * The order matters: the entry is found (org-scoped), the ciphertext is
 * verified and decrypted, and only then is the row stamped and the audit row
 * written — so a reveal that failed to decrypt leaves no "X looked at this"
 * behind, and a reveal that is on record really did hand the plaintext over.
 * The audit row never carries the secret; the row itself carries who and when.
 */
export async function revealAccessSecret(
  db: Db,
  organisationId: string,
  input: RevealAccessSecretInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RevealedAccessSecret> {
  const v = RevealAccessSecretInput.parse(input);
  const entry = await getStoredEntry(db, organisationId, v.entryId);
  if (!entry.secretCiphertext) throw new Error(`"${entry.label}" holds no password to reveal`);

  const secret = decryptSecret(entry.secretCiphertext, loadEncryptionKey(env));

  const lastViewedAt = new Date();
  await db
    .update(schema.clientAccessEntries)
    .set({ lastViewedAt, lastViewedBy: v.actorId })
    .where(and(eq(schema.clientAccessEntries.id, entry.id), eq(schema.clientAccessEntries.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    actorId: v.actorId,
    action: "client_access.revealed",
    targetType: ACCESS_TARGET_TYPE,
    targetId: entry.id,
    after: { clientId: entry.clientId, kind: entry.kind, label: entry.label, username: entry.username },
  });

  return { secret, label: entry.label, clientId: entry.clientId, lastViewedAt };
}
