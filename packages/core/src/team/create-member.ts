import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { generateOneTimePassword } from "./password.js";

// Better Auth namespaces credential accounts as "local:<providerId>"
// (createLocalAccountIssuer in @better-auth/core/db). Same shape the seed writes.
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

export const CreateMemberInput = z.object({
  email: z.string().email().trim().toLowerCase(),
  displayName: z.string().min(1).max(200),
  role: z.enum(["owner", "staff"]).default("staff"),
  title: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  invitedBy: z.string().optional(),
});
export type CreateMemberInput = z.input<typeof CreateMemberInput>;

/**
 * Sign-up is disabled, so an account is only ever created here: the admin adds
 * the person, the returned one-time password is shown once and never stored in
 * plain text. An existing Better Auth user (a client-portal user, say) is
 * reused rather than duplicated; only their membership is new.
 */
export async function createMember(db: Db, organisationId: string, input: CreateMemberInput) {
  const v = CreateMemberInput.parse(input);
  const oneTimePassword = generateOneTimePassword();
  const passwordHash = await hashPassword(oneTimePassword);

  const member = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [existingUser] = await tx.select().from(schema.user).where(eq(schema.user.email, v.email));

    if (existingUser) {
      const [existingMember] = await tx
        .select({ id: schema.organisationMembers.id })
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.organisationId, organisationId),
            eq(schema.organisationMembers.userId, existingUser.id),
          ),
        );
      if (existingMember) throw new Error(`${v.email} is already a member of this organisation`);
    }

    const userId = existingUser?.id ?? randomUUID();
    if (!existingUser) {
      await tx.insert(schema.user).values({ id: userId, name: v.displayName, email: v.email, emailVerified: true });
    }

    const [credential] = await tx
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
    if (credential) {
      await tx.update(schema.account).set({ password: passwordHash, updatedAt: new Date() }).where(eq(schema.account.id, credential.id));
    } else {
      await tx.insert(schema.account).values({
        id: randomUUID(),
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER,
        issuer: CREDENTIAL_ISSUER,
        userId,
        password: passwordHash,
      });
    }

    const [row] = await tx
      .insert(schema.organisationMembers)
      .values({
        organisationId,
        userId,
        displayName: v.displayName,
        title: v.title ?? null,
        phone: v.phone ?? null,
        invitedBy: v.invitedBy ?? null,
        initialPasswordSetAt: new Date(),
        role: v.role,
        status: "active",
      })
      .returning();

    await recordAudit(inner, organisationId, {
      actorKind: "user",
      actorId: v.invitedBy,
      action: "member.created",
      targetType: "organisation_member",
      targetId: row!.id,
      // The password hash is never audited, and the plain password never leaves this call.
      after: { id: row!.id, userId, email: v.email, role: row!.role, displayName: row!.displayName },
    });
    return row!;
  });

  await notifyOwner(db, organisationId, {
    kind: "member.created",
    title: `Team member added: ${v.displayName}`,
    body: v.email,
    link: "/team",
  });
  await emit({ name: "member.created", organisationId, memberId: member.id });
  return { member, oneTimePassword };
}
