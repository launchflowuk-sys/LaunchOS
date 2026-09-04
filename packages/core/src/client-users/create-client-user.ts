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
  role: z.enum(["client_admin", "client_member"]).default("client_member"),
  // The admin granting the access. Optional so callers outside a request (the
  // seed, a future agent tool) still work, but the web action always passes it
  // — "a user granted portal access" is not an answer once staff share the
  // admin. Same role `invitedBy` plays in `team/create-member.ts`.
  actorId: z.string().optional(),
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
 *
 * Mirrors `team/create-member.ts`'s account-reuse safety: an existing user is
 * only ever reused if they have no credential of their own (reusing one and
 * resetting its password would let anyone who knows an email hijack an
 * existing login), and a current staff member (any `organisation_members` row
 * in this org, regardless of status) is never also given portal access, since
 * that would blur the staff/client trust boundary the two logins exist to
 * keep apart.
 */
export async function createClientUser(db: Db, organisationId: string, input: CreateClientUserInput) {
  const v = CreateClientUserInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  const email = v.email.trim().toLowerCase();

  const password = oneTimePassword();
  const hashed = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [existingUser] = await tx.select().from(schema.user).where(eq(schema.user.email, email));

    if (existingUser) {
      const [credential] = await tx
        .select({ id: schema.account.id })
        .from(schema.account)
        .where(and(eq(schema.account.userId, existingUser.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
      if (credential) throw new Error("email already registered");

      const [staffRow] = await tx
        .select({ id: schema.organisationMembers.id })
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.organisationId, organisationId),
            eq(schema.organisationMembers.userId, existingUser.id),
          ),
        );
      if (staffRow) throw new Error("staff accounts cannot be client users");
    }

    const user =
      existingUser ??
      (await tx.insert(schema.user).values({ id: randomUUID(), name: v.name, email, emailVerified: true }).returning())[0]!;

    // Reached only when this user has no credential yet — either a brand new
    // user, or an existing Better Auth user (e.g. seeded directly) that was
    // never issued a login of their own.
    await tx.insert(schema.account).values({
      id: randomUUID(), accountId: user.id, providerId: CREDENTIAL_PROVIDER, issuer: CREDENTIAL_ISSUER,
      userId: user.id, password: hashed,
    });

    const [clientUser] = await tx
      .insert(schema.clientUsers)
      .values({ organisationId, clientId: v.clientId, userId: user.id, role: v.role })
      .returning();

    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "client_user.created", targetType: "client_user", targetId: clientUser!.id,
      after: { clientId: v.clientId, userId: user.id, email, role: v.role },
    });
    await recordActivity(inner, organisationId, {
      clientId: v.clientId, actorKind: "user", actorId: v.actorId, kind: "portal.user_invited",
      title: `Portal access granted to ${email}`, link: `/clients/${v.clientId}/portal-users`,
    });

    return { user, clientUser: clientUser! };
  });

  return { ...created, oneTimePassword: password };
}
