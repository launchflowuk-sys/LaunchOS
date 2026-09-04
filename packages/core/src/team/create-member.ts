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
type ParsedCreateMemberInput = z.infer<typeof CreateMemberInput>;

/**
 * Resolves the Better Auth user for this email, or creates one.
 *
 * An existing user who already has a credential account is never touched:
 * reusing their id and resetting `account.password` would let anyone who
 * knows a person's email add them as "staff" in an unrelated organisation and
 * take over their existing login — a cross-tenant account-takeover path, not
 * a legitimate re-invite. So that case throws instead. A user who exists but
 * has no credential yet (e.g. a client-portal account, or any future
 * passwordless user) gets one created; a brand-new email gets both a user and
 * a credential.
 */
async function resolveOrCreateUserWithCredential(
  tx: Db,
  organisationId: string,
  v: Pick<ParsedCreateMemberInput, "email" | "displayName">,
  passwordHash: string,
): Promise<string> {
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

    const [credential] = await tx
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, existingUser.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
    if (credential) throw new Error("email already registered");

    await tx.insert(schema.account).values({
      id: randomUUID(),
      accountId: existingUser.id,
      providerId: CREDENTIAL_PROVIDER,
      issuer: CREDENTIAL_ISSUER,
      userId: existingUser.id,
      password: passwordHash,
    });
    return existingUser.id;
  }

  const userId = randomUUID();
  await tx.insert(schema.user).values({ id: userId, name: v.displayName, email: v.email, emailVerified: true });
  await tx.insert(schema.account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: CREDENTIAL_PROVIDER,
    issuer: CREDENTIAL_ISSUER,
    userId,
    password: passwordHash,
  });
  return userId;
}

/** Inserts the membership row and its creation audit entry. */
async function insertMembershipAndAudit(tx: Db, organisationId: string, userId: string, v: ParsedCreateMemberInput) {
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

  await recordAudit(tx, organisationId, {
    actorKind: "user",
    actorId: v.invitedBy,
    action: "member.created",
    targetType: "organisation_member",
    targetId: row!.id,
    // The password hash is never audited, and the plain password never leaves this call.
    after: { id: row!.id, userId, email: v.email, role: row!.role, displayName: row!.displayName },
  });
  return row!;
}

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
    const userId = await resolveOrCreateUserWithCredential(inner, organisationId, v, passwordHash);
    return insertMembershipAndAudit(inner, organisationId, userId, v);
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
