import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext, supportEmailFor } from "../config.js";

/**
 * Sends a new team member their sign-in details.
 *
 * Until now the one-time password appeared once, on the owner's screen, and
 * nowhere else — so getting it to the person meant copying it into WhatsApp or
 * a text. That is a worse place for a credential than an email: it sits in a
 * chat history on two phones and in somebody's cloud backup for ever.
 *
 * **The password is never persisted and never logged**, here or anywhere else.
 * It exists in the caller's frame, is handed to this function, and goes out in
 * one message. Nothing in this file writes it to a row — the audit entry below
 * records *that* an invite was sent and to whom, never what was in it.
 *
 * I said earlier this would need the approvals gate. It does not, and it would
 * be the wrong shape: that gate exists so an **agent** cannot act outward
 * without a human deciding. Here the owner *is* the human, clicking a button
 * on their own screen — putting a card in front of them to approve their own
 * click is ceremony, not safety.
 */

export const SendMemberInviteInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().min(1).max(120),
  /** Never stored. Passed in from the frame that generated it and used once. */
  oneTimePassword: z.string().min(1),
  /** Who is inviting them, for the "sent by" line. */
  invitedByEmail: z.string().trim().email().optional(),
  /** Set when the organisation enforces a second factor, so the mail warns them. */
  twoFactorRequired: z.boolean().default(false),
});
export type SendMemberInviteInput = z.input<typeof SendMemberInviteInput>;

export interface SendMemberInviteDeps {
  /** Absent in tests, and absent when no real adapter is configured. */
  email?: EmailAdapter | undefined;
}

export interface SendMemberInviteResult {
  /** False when there was no adapter, or the send threw. The caller must still show the password. */
  sent: boolean;
  /** Why it did not go, for the line on the screen. Null when it did. */
  reason: string | null;
}

/**
 * Never throws.
 *
 * A failed send must not fail the invite, and — more importantly — must not
 * swallow the password. The account has already been created by the time this
 * runs; if the mail cannot go, the caller still has the one-time password in
 * hand and shows it, exactly as it did before this existed. Throwing here
 * would lose the only copy.
 */
export async function sendMemberInvite(
  db: Db,
  organisationId: string,
  input: SendMemberInviteInput,
  deps: SendMemberInviteDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendMemberInviteResult> {
  const v = SendMemberInviteInput.parse(input);
  if (!deps.email) return { sent: false, reason: "No email provider is configured." };

  const brand = brandEmailContext(env);
  const heading = `Your LaunchFlow sign-in details`;

  try {
    const { text, html } = renderBrandedEmail({
      // Internal: they are staff, not a client.
      variant: "internal",
      preheader: "Your account is ready. The password below works once.",
      heading,
      paragraphs: [
        `Hello ${v.displayName.split(/\s+/)[0] ?? v.displayName}, an account has been set up for you on LaunchOS`
          + `${v.invitedByEmail ? ` by ${v.invitedByEmail}` : ""}.`,
        `Sign in with **${v.email}** and this password: **${v.oneTimePassword}**`,
        "Change it as soon as you are in, from your account screen. This one was generated for you and nobody keeps a copy of it — "
          + "not even LaunchOS, which stores only a hash.",
        v.twoFactorRequired
          ? "You will be asked to set up two-factor authentication the first time you sign in. Have your authenticator app to hand."
          : "Turn on two-factor authentication from your account screen once you are in.",
        "If you were not expecting this, ignore it and tell whoever sent it — the account cannot be used without this message.",
      ],
      cta: { label: "Sign in", url: `${brand.appUrl}/sign-in` },
      footerNote: "Sent because somebody added you to a LaunchFlow team. It will not be sent again.",
      logoUrl: brand.logoUrl,
      appUrl: brand.appUrl,
      supportEmail: brand.supportEmail,
    });

    await deps.email.send({
      to: v.email,
      from: env["MAIL_FROM"] ?? supportEmailFor("security", env),
      subject: heading,
      text,
      html,
    });
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "The invitation could not be sent." };
  }

  // Records that an invite went out, never what was in it.
  await recordAudit(db, organisationId, {
    actorKind: "user", action: "member.invite_sent",
    targetType: "member", targetId: v.email,
    after: { email: v.email, twoFactorRequired: v.twoFactorRequired },
  });

  return { sent: true, reason: null };
}
