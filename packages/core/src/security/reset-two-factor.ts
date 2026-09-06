import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext, supportEmailFor } from "../config.js";
import { notifyOwner } from "../notifications/notify.js";
import { ukLongDate } from "../tasks/dates.js";

/** Every refusal this service makes, with a sentence safe to show on the screen. */
export class TwoFactorResetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoFactorResetRefused";
  }
}

export const ResetTwoFactorInput = z.object({
  /** The `user.id` whose second factor comes off. */
  targetUserId: z.string().min(1),
  /** The `user.id` of the owner doing it. Never optional: this is a lock. */
  actorId: z.string().min(1),
  /**
   * The owner's own password, re-typed. Verified here and nowhere else, never
   * stored, never logged and never put in the audit payload.
   */
  actorPassword: z.string().min(1),
});
export type ResetTwoFactorInput = z.input<typeof ResetTwoFactorInput>;

export interface ResetTwoFactorDeps {
  /** Absent in tests that do not care about the notice; the reset still happens. */
  email?: EmailAdapter | undefined;
}

export interface ResetTwoFactorResult {
  targetUserId: string;
  /** The account the factor came off, for the confirmation the screen shows. */
  email: string;
  kind: "member" | "portal";
  enrolmentsRemoved: number;
  sessionsEnded: number;
  /** False when the notice to the account holder could not be sent. */
  emailed: boolean;
}

// Better Auth namespaces password logins under this provider; the same two
// constants appear in team/reissue-password.ts and team/create-member.ts.
const CREDENTIAL_PROVIDER = "credential";

type Target = {
  userId: string;
  email: string;
  kind: "member" | "portal";
  twoFactorEnabled: boolean;
};

/**
 * The person whose factor is coming off, as this organisation knows them.
 *
 * Staff membership first, then a portal account, both filtered on
 * `organisationId` — a `user.id` guessed from another tenant resolves to
 * nothing here and is refused as "not part of this organisation", which is the
 * whole tenancy guarantee of this service. Status is deliberately not filtered:
 * a suspended member or a portal account somebody has just switched off is
 * exactly when a lost authenticator still needs clearing, and refusing would
 * send an owner back to the SQL console this feature exists to replace.
 */
async function resolveTarget(db: Db, organisationId: string, userId: string): Promise<Target | null> {
  const [member] = await db
    .select({ email: schema.user.email, enabled: schema.user.twoFactorEnabled })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (member) {
    return { userId, email: member.email, kind: "member", twoFactorEnabled: member.enabled };
  }

  const [portal] = await db
    .select({ email: schema.user.email, enabled: schema.user.twoFactorEnabled })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.userId, userId)))
    .limit(1);
  if (portal) {
    return { userId, email: portal.email, kind: "portal", twoFactorEnabled: portal.enabled };
  }

  return null;
}

/** True when this user is an active owner of this organisation. */
async function isActiveOwner(db: Db, organisationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, userId),
        eq(schema.organisationMembers.role, "owner"),
        eq(schema.organisationMembers.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
}

/** The account holder's own notice that their second factor is gone. */
async function emailTheAccountHolder(
  deps: ResetTwoFactorDeps,
  target: Target,
  actorEmail: string,
  enforced: boolean,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!deps.email) return false;
  const brand = brandEmailContext(env);
  const accountPath = target.kind === "member" ? "/account" : "/portal/account";
  const heading = "Your two-factor authentication was reset";
  const nextStep =
    target.kind === "member" && enforced
      ? "The team requires two-factor, so you will be asked to set it up again the next time you sign in."
      : `Set it up again from your account screen at ${brand.appUrl}${accountPath} as soon as you can.`;

  const { text, html } = renderBrandedEmail({
    // A staff member is one of us and a portal user is a client; the compact
    // internal card and the full client card are exactly that distinction.
    variant: target.kind === "member" ? "internal" : "client",
    preheader: "An owner removed the authenticator from your LaunchOS account.",
    heading,
    paragraphs: [
      `${actorEmail} reset the two-factor authentication on your LaunchOS account (${target.email}) on ${ukLongDate(new Date())}.`,
      "Your authenticator app and your backup codes have stopped working, you can sign in with your password alone, and every device that was signed in as you has been signed out.",
      nextStep,
      "If you did not ask for this, say so straight away and change your password: somebody with an owner account has changed how yours is protected.",
    ],
    cta: { label: "Set up two-factor again", url: `${brand.appUrl}${accountPath}` },
    footerNote: "An automatic security notice. It carries no codes and asks for nothing back.",
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });

  await deps.email.send({
    to: target.email,
    from: env.MAIL_FROM ?? supportEmailFor("security", env),
    subject: heading,
    text,
    html,
  });
  return true;
}

/**
 * Takes somebody else's second factor off, as an owner, with a password.
 *
 * The recovery path for the one thing two-factor makes unrecoverable: a phone
 * that went in the river along with the printed backup codes. Until this
 * existed the answer was three `delete` statements against production, run by
 * hand, outside the application and therefore outside `audit_log` — which is
 * both a poor experience and an unrecorded change to how an account is
 * protected. This is the same three statements with every guarantee the rest
 * of the product has.
 *
 * Stripping a second factor is also precisely what an attacker holding a
 * stolen laptop would do, so it is fenced accordingly:
 *
 *  - **Only an active owner of this organisation.** That single gate is what
 *    stops the feature becoming an escalation: a staff member cannot reset
 *    another staff member, cannot reset an owner, and nobody outside the
 *    organisation can reset anybody. A second, narrower check for "is the
 *    target an owner" would be dead code behind it; the tests prove each of
 *    those three refusals instead. Asserted here rather than left to the
 *    screen, because the next caller (an agent tool, a worker job) inherits
 *    nothing from a screen.
 *  - **The owner's own password, re-typed.** The same standard `/account`
 *    already sets for switching your *own* factor off, and for the same
 *    reason: a live session on a laptop somebody walked off with must not be
 *    enough. Verified against the stored credential hash, so no session, cookie
 *    or form can stand in for it.
 *  - **Never yourself.** Turning your own factor off is `/account`, which
 *    rotates your session cookie properly and is audited as your own act. A
 *    self-reset here would be the same change wearing somebody else's audit
 *    row, and it is the one call that could sign the caller out mid-flight.
 *  - **Only somebody who actually has a factor.** A reset of an account with
 *    nothing on it is an audited no-op that reads, later, exactly like a real
 *    one.
 *
 * Every session on the target account is deleted with the enrolment. The
 * account is weaker than it was a moment ago and the usual reason for the
 * reset is a device that is gone, so a session opened on that device must go
 * with it — the same argument `reissueOneTimePassword` makes about a replaced
 * password. Under organisation-wide enforcement this is also what makes the
 * landing clean: their next sign-in is password-only, `requireAdmin` sees an
 * unenrolled member and sends them to `/account?two-factor=required`, which is
 * enrolment rather than a lock-out.
 *
 * The notice to the account holder is sent **after** the transaction commits
 * and can never undo it: a mail server having a bad afternoon must not leave a
 * lost authenticator un-clearable. A failed send comes back as
 * `emailed: false`, is logged, and changes what the owner's bell says so the
 * gap is somebody's job rather than a silence.
 */
export async function resetTwoFactor(
  db: Db,
  organisationId: string,
  input: ResetTwoFactorInput,
  deps: ResetTwoFactorDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResetTwoFactorResult> {
  const v = ResetTwoFactorInput.parse(input);

  if (v.targetUserId === v.actorId) {
    throw new TwoFactorResetRefused(
      "Turn your own two-factor off from your Account screen — this is for somebody else's account.",
    );
  }

  // The owner check and the password check are reads, so they happen before
  // the transaction: password verification is a deliberately slow KDF and has
  // no business holding a database connection open. The membership is read
  // again inside the transaction, where the write is, so an owner demoted in
  // between cannot slip a reset through on a stale answer.
  if (!(await isActiveOwner(db, organisationId, v.actorId))) {
    throw new TwoFactorResetRefused("Only an owner can reset somebody else's two-factor.");
  }

  const [actor] = await db
    .select({ email: schema.user.email, password: schema.account.password })
    .from(schema.account)
    .innerJoin(schema.user, eq(schema.account.userId, schema.user.id))
    .where(and(eq(schema.account.userId, v.actorId), eq(schema.account.providerId, CREDENTIAL_PROVIDER)))
    .limit(1);
  if (!actor?.password || !(await verifyPassword({ hash: actor.password, password: v.actorPassword }))) {
    throw new TwoFactorResetRefused("That password was not accepted.");
  }

  const target = await resolveTarget(db, organisationId, v.targetUserId);
  if (!target) throw new TwoFactorResetRefused("That account is not part of this organisation.");
  if (!target.twoFactorEnabled) throw new TwoFactorResetRefused("That account does not have two-factor set up.");

  const [org] = await db
    .select({ enforced: schema.organisations.requireStaffTwoFactor })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId))
    .limit(1);

  const outcome = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!(await isActiveOwner(tx, organisationId, v.actorId))) {
      throw new TwoFactorResetRefused("Only an owner can reset somebody else's two-factor.");
    }

    const enrolments = await tx
      .delete(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, v.targetUserId))
      .returning({ id: schema.twoFactor.id });

    await tx
      .update(schema.user)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(schema.user.id, v.targetUserId));

    const sessions = await tx
      .delete(schema.session)
      .where(eq(schema.session.userId, v.targetUserId))
      .returning({ id: schema.session.id });

    await recordAudit(tx, organisationId, {
      actorKind: "user",
      actorId: v.actorId,
      action: "security.two_factor_reset",
      targetType: "user",
      targetId: v.targetUserId,
      before: { twoFactorEnabled: true },
      // Who reset whom, in one row. Neither the owner's password nor anything
      // that was in the `two_factor` row goes anywhere near this payload.
      after: {
        twoFactorEnabled: false,
        account: target.email,
        accountKind: target.kind,
        resetBy: actor.email,
        enrolmentsRemoved: enrolments.length,
        sessionsEnded: sessions.length,
      },
    });

    return { enrolmentsRemoved: enrolments.length, sessionsEnded: sessions.length };
  });

  // ---- Past this line the factor is gone and nothing may undo it. ----

  let emailed = false;
  try {
    emailed = await emailTheAccountHolder(deps, target, actor.email, org?.enforced ?? false, env);
  } catch (error) {
    console.error(
      { organisationId, targetUserId: v.targetUserId, error: error instanceof Error ? error.message : String(error) },
      "two-factor reset notice could not be emailed",
    );
  }

  // One bell for the organisation, worded to match what actually happened, so
  // an owner never has to wonder whether the person was told.
  try {
    await notifyOwner(db, organisationId, {
      kind: "security.two_factor_reset",
      title: "Two-factor reset for an account",
      body: emailed
        ? `${actor.email} reset the two-factor on ${target.email}. They have been emailed about it and will be asked to set it up again.`
        : `${actor.email} reset the two-factor on ${target.email}. The email telling them could not be sent — tell them yourself.`,
      link: target.kind === "member" ? "/team" : "/clients",
    });
  } catch (error) {
    console.error(
      { organisationId, targetUserId: v.targetUserId, error: error instanceof Error ? error.message : String(error) },
      "two-factor reset happened but the owner notification failed",
    );
  }

  return {
    targetUserId: v.targetUserId,
    email: target.email,
    kind: target.kind,
    enrolmentsRemoved: outcome.enrolmentsRemoved,
    sessionsEnded: outcome.sessionsEnded,
    emailed,
  };
}
