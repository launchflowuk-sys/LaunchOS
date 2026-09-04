"use server";

import { createEmailAdapter } from "@launchos/channels";
import { recordAudit } from "@launchos/core";
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
  const result = await adapter.send({
    to,
    from: process.env.MAIL_FROM ?? to,
    subject: "LaunchOS test email",
    text: `Sent from LaunchOS Settings → Email at ${new Date().toISOString()} using the ${adapter.name} adapter.`,
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
