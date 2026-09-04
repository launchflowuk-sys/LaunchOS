import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { generateOneTimePassword } from "./password.js";

// Same two constants as create-member.ts and the seed: Better Auth namespaces
// credential accounts as "local:<providerId>".
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

export const ReissueOneTimePasswordInput = z.object({
  memberId: z.string().uuid(),
  // Required, unlike the other team services: this one replaces a credential,
  // so it asserts for itself that the caller is an active owner rather than
  // trusting the screen that called it (see the owner check below).
  actor: z.string().min(1),
});
export type ReissueOneTimePasswordInput = z.input<typeof ReissueOneTimePasswordInput>;

/**
 * The missing half of an admin-only account system. `createMember` shows a
 * one-time password exactly once and never stores it in plain text, so anything
 * that loses it — the dialog closed too early, a browser crash, a post-commit
 * side effect that failed before the result reached the screen — leaves a
 * committed membership and credential nobody can sign in with. Sign-up is
 * disabled and there is no self-service reset, so without this the account and
 * the email address are both burned for good.
 *
 * Deliberately narrow, because "replace this person's password" is the exact
 * shape of an account takeover:
 *
 *  - The caller must be an *active owner* of this organisation. Every other
 *    team service leaves authorisation to the server action; this one asserts
 *    it, because the next caller (an agent tool, a worker job) would otherwise
 *    inherit nothing.
 *  - Only an **active** member of *this* organisation, looked up under
 *    `organisationId`. An `invited` row is a membership nobody has completed:
 *    it has no credential, `createMember` is the only path that completes it,
 *    and that path refuses outright once a credential exists. Minting one here
 *    would strand the membership as `invited` for good — the account, the
 *    membership and the email address all permanently dead. Invitations are
 *    finished through `createMember`, never through this.
 *  - Only while `initial_password_set_at IS NULL`. That column records the
 *    moment a member replaces the issued password with one of their own; NULL
 *    means they are still on the admin-issued one and there is nothing personal
 *    to overwrite. Once it is stamped, the credential belongs to them and this
 *    refuses — a real reset flow (email-verified) is the answer then, not this.
 *  - Only when the underlying Better Auth user belongs nowhere else. One
 *    credential row backs every organisation the user is in, so re-issuing for
 *    a user who is also a member of another organisation, or a client-portal
 *    user anywhere, would reach straight across the tenant boundary — the same
 *    hole `createMember` refuses to open.
 *
 * Every session the old password opened is deleted in the same transaction:
 * unlike `deactivateMember`, which `getSession` re-checks on every request, a
 * password change has no such re-check, so without this an owner resetting a
 * leaked password would leave the leaker signed in until the cookie expired.
 *
 * The new password is returned once and audited only as the fact that it
 * happened — never the value, never the hash.
 */
export async function reissueOneTimePassword(db: Db, organisationId: string, input: ReissueOneTimePasswordInput) {
  const v = ReissueOneTimePasswordInput.parse(input);
  const oneTimePassword = generateOneTimePassword();
  const passwordHash = await hashPassword(oneTimePassword);

  const member = await db.transaction(async (tx) => {
    const [actorRow] = await tx
      .select({ id: schema.organisationMembers.id })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.organisationId, organisationId),
          eq(schema.organisationMembers.userId, v.actor),
          eq(schema.organisationMembers.role, "owner"),
          eq(schema.organisationMembers.status, "active"),
        ),
      );
    if (!actorRow) throw new Error("only an active owner can re-issue a password");

    const [row] = await tx
      .select({
        id: schema.organisationMembers.id,
        userId: schema.organisationMembers.userId,
        status: schema.organisationMembers.status,
        displayName: schema.organisationMembers.displayName,
        email: schema.user.email,
      })
      .from(schema.organisationMembers)
      .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
      .where(
        and(
          eq(schema.organisationMembers.id, v.memberId),
          eq(schema.organisationMembers.organisationId, organisationId),
          isNull(schema.organisationMembers.initialPasswordSetAt),
        ),
      );
    if (!row) throw new Error("no re-issuable member with that id in this organisation");
    if (row.status === "suspended") throw new Error("cannot re-issue a password for a suspended member");
    if (row.status !== "active") {
      throw new Error("cannot re-issue a password for a pending invitation — add the member to complete it instead");
    }

    const [elsewhere] = await tx
      .select({ id: schema.organisationMembers.id })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.userId, row.userId),
          ne(schema.organisationMembers.organisationId, organisationId),
        ),
      );
    const [portalRow] = await tx
      .select({ id: schema.clientUsers.id })
      .from(schema.clientUsers)
      .where(eq(schema.clientUsers.userId, row.userId));
    if (elsewhere || portalRow) throw new Error("this account is used outside this organisation");

    const updated = await tx
      .update(schema.account)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(and(eq(schema.account.userId, row.userId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)))
      .returning({ id: schema.account.id });

    // A member whose credential insert never happened (or was rolled back) is
    // exactly the stranded case this exists for, so issue one rather than fail.
    // Reachable only for an `active` member now, which is what its comment
    // always claimed: an `invited` row is refused above.
    if (updated.length === 0) {
      await tx.insert(schema.account).values({
        id: randomUUID(),
        accountId: row.userId,
        providerId: CREDENTIAL_PROVIDER,
        issuer: CREDENTIAL_ISSUER,
        userId: row.userId,
        password: passwordHash,
      });
    }

    // The old password stops working; so does every session it opened.
    const endedSessions = await tx
      .delete(schema.session)
      .where(eq(schema.session.userId, row.userId))
      .returning({ id: schema.session.id });

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user",
      actorId: v.actor,
      action: "member.password_reissued",
      targetType: "organisation_member",
      targetId: row.id,
      // Neither the password nor its hash is ever audited.
      after: {
        id: row.id,
        userId: row.userId,
        email: row.email,
        credentialCreated: updated.length === 0,
        sessionsEnded: endedSessions.length,
      },
    });

    return { id: row.id, userId: row.userId, email: row.email, displayName: row.displayName };
  });

  return { member, oneTimePassword };
}
