"use server";

import { createEmailAdapter, renderBrandedEmail } from "@launchos/channels";
import { brandEmailContext, recordAudit } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * Owner notifications bypass the approval gate (spec §4, Outbound email), and
 * this only ever sends to OWNER_NOTIFY_EMAIL — never to an address supplied in
 * the request.
 */
export async function sendTestEmail() {
  const session = await requireAdmin();
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!to) throw new Error("OWNER_NOTIFY_EMAIL is not set");

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
  const result = await adapter.send({
    to,
    from: process.env.MAIL_FROM ?? to,
    subject: "LaunchOS test email",
    text,
    html,
  });

  await recordAudit(getDb(), session.organisationId, {
    actorKind: "user",
    actorId: session.userId,
    action: "email.test_sent",
    targetType: "organisation",
    targetId: session.organisationId,
    after: { to, adapter: adapter.name, providerMessageId: result.providerMessageId },
  });
  revalidatePath("/settings/email");
}
