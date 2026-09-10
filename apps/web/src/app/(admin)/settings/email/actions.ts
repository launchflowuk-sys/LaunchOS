"use server";

import { createEmailAdapter, renderBrandedEmail } from "@launchos/channels";
import { brandEmailContext, recordAudit } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdminWith } from "@/lib/permissions";

/**
 * Owner notifications bypass the approval gate (spec §4, Outbound email), and
 * this only ever sends to OWNER_NOTIFY_EMAIL — never to an address supplied in
 * the request.
 */
/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok"; message?: string } | { status: "error"; message: string };

/**
 * Sends one email to the owner and says what happened.
 *
 * It used to throw. A server action that throws takes the whole screen to the
 * error boundary, so a wrong SMTP password read as "Something went wrong" with
 * a reference number — and the actual answer, `535 Authentication
 * unsuccessful`, was only ever visible in a container log. The failure a person
 * is *testing for* is exactly the one they could not see.
 *
 * The provider's own words are returned rather than a tidy sentence: "the
 * server rejected the login" sends somebody to the wrong place, and
 * `535 5.7.3` names it.
 */
export async function sendTestEmail(): Promise<ActionResult> {
  const session = await requireAdminWith("settings");
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!to) return { status: "error", message: "OWNER_NOTIFY_EMAIL is not set, so there is nowhere to send it." };

  const adapter = createEmailAdapter(process.env);
  const brand = brandEmailContext(process.env);
  // The compact internal variant: this is a message to ourselves, and dressing
  // it like a client email would make the two hard to tell apart in one inbox.
  // It still wears the shell, because that is the point of the test — it is
  // what proves the branded layout renders in the owner's real mail client.
  const { text, html } = renderBrandedEmail({
    variant: "internal",
    preheader: `Sent with the ${adapter.name} adapter.`,
    heading: "LaunchOS test email",
    paragraphs: [
      `Sent from LaunchOS Settings → Email at ${new Date().toISOString()} using the ${adapter.name} adapter.`,
      "If this arrived, outbound email works and the branded layout renders in your client.",
    ],
    cta: { label: "Open LaunchOS", url: `${brand.appUrl}/settings/email` },
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });
  let result;
  try {
    result = await adapter.send({
      to,
      from: process.env.MAIL_FROM ?? to,
      subject: "LaunchOS test email",
      text,
      html,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "error", message: `${adapter.name} refused it: ${detail}` };
  }

  await recordAudit(getDb(), session.organisationId, {
    actorKind: "user",
    actorId: session.userId,
    action: "email.test_sent",
    targetType: "organisation",
    targetId: session.organisationId,
    after: { to, adapter: adapter.name, providerMessageId: result.providerMessageId },
  });
  revalidatePath("/settings/email");
  return { status: "ok", message: `Sent to ${to} with the ${adapter.name} adapter.` };
}
