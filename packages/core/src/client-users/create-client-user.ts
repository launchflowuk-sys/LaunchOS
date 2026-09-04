import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const CreateClientUserInput = z.object({
  clientId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(120),
});
export type CreateClientUserInput = z.input<typeof CreateClientUserInput>;

// Better Auth namespaces credential accounts as "local:<providerId>"; the seed
// uses the same two constants.
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;
const OTP_LENGTH = 16;

/** URL-safe, no ambiguous characters, shown to Shoji exactly once. */
function oneTimePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(OTP_LENGTH);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Admin-created portal account. Sign-up stays disabled in Better Auth, so this
 * is the only way a client user comes into existence. The plaintext password is
 * returned once and never stored.
 */
export async function createClientUser(db: Db, organisationId: string, input: CreateClientUserInput) {
  const v = CreateClientUserInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  const email = v.email.trim().toLowerCase();

  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (existingUser) {
    const [link] = await db
      .select()
      .from(schema.clientUsers)
      .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.userId, existingUser.id)));
    if (link) throw new Error(`${email} already has a portal account`);
  }

  const password = oneTimePassword();
  const hashed = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const user =
      existingUser ??
      (await tx.insert(schema.user).values({ id: randomUUID(), name: v.name, email, emailVerified: true }).returning())[0]!;
    if (!existingUser) {
      await tx.insert(schema.account).values({
        id: randomUUID(), accountId: user.id, providerId: CREDENTIAL_PROVIDER, issuer: CREDENTIAL_ISSUER,
        userId: user.id, password: hashed,
      });
    }
    const [clientUser] = await tx
      .insert(schema.clientUsers)
      .values({ organisationId, clientId: v.clientId, userId: user.id, role: "client_admin" })
      .returning();
    return { user, clientUser: clientUser! };
  });

  await recordAudit(db, organisationId, {
    actorKind: "user", action: "client_user.created", targetType: "client_user", targetId: created.clientUser.id,
    after: { clientId: v.clientId, userId: created.user.id, email },
  });
  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: "user", kind: "portal.user_invited",
    title: `Portal access granted to ${email}`, link: `/clients/${v.clientId}/portal-users`,
  });

  return { ...created, oneTimePassword: password };
}
