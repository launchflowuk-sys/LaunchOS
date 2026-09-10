import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { brandEmailContext, supportEmailFor } from "../config.js";

/**
 * The two emails a submitted brief has to produce.
 *
 * There were none. A brief arrived, a bell lit up inside the portal, and that
 * was it — so nobody found out until somebody happened to open LaunchOS, and
 * the customer had no idea whether it had gone anywhere at all. Both of those
 * are the same fault: an in-app notification is not a notification to a person
 * who is not in the app.
 *
 * Both are best effort and neither can fail the submission. By the time this
 * runs the brief is already stored with its reference; an email that does not
 * send is a thing to chase, not a reason to lose the enquiry.
 */

export interface SubmittedEmailResult {
  owner: "sent" | "skipped" | "failed";
  customer: "sent" | "skipped" | "failed";
}

export async function sendBriefSubmittedEmails(
  db: Db,
  organisationId: string,
  submissionId: string,
  email: EmailAdapter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubmittedEmailResult> {
  const result: SubmittedEmailResult = { owner: "skipped", customer: "skipped" };

  const [submission] = await db
    .select()
    .from(schema.briefSubmissions)
    .where(
      and(
        eq(schema.briefSubmissions.id, submissionId),
        eq(schema.briefSubmissions.organisationId, organisationId),
      ),
    );
  if (!submission) return result;

  const answers = submission.answers as Record<string, unknown>;
  const business = String(answers.business ?? answers.name ?? "a new enquiry");
  const person = String(answers.name ?? "");
  const customerEmail = typeof answers.email === "string" ? answers.email.trim() : "";
  const phone = typeof answers.phone === "string" ? answers.phone.trim() : "";

  const brand = brandEmailContext(env);
  const from = env.MAIL_FROM ?? supportEmailFor("hello", env);

  // ---------------------------------------------------------------- to Shoji
  const ownerTo = env.OWNER_NOTIFY_EMAIL?.trim();
  if (ownerTo) {
    const { text, html } = renderBrandedEmail({
      variant: "internal",
      preheader: `${business} — reference ${submission.reference}.`,
      heading: `Website brief: ${business}`,
      paragraphs: [
        `${person || "Someone"} has finished the questionnaire.`,
        [
          customerEmail ? `Email: ${customerEmail}` : null,
          phone ? `Phone: ${phone}` : null,
          `Reference: ${submission.reference}`,
        ].filter(Boolean).join("\n"),
        "Every answer is on the lead in LaunchOS, along with the written brief.",
      ],
      cta: { label: "Open the lead", url: `${brand.appUrl.replace(/\/$/, "")}/leads` },
      logoUrl: brand.logoUrl,
      appUrl: brand.appUrl,
      supportEmail: brand.supportEmail,
    });
    try {
      await email.send({ to: ownerTo, from, subject: `Website brief: ${business}`, text, html });
      result.owner = "sent";
    } catch {
      result.owner = "failed";
    }
  }

  // ------------------------------------------------------------- to them
  // Only when they gave an address. A phone-only enquiry is perfectly valid
  // and simply does not get one of these.
  if (customerEmail) {
    const { text, html } = renderBrandedEmail({
      preheader: "We have your brief. Here is your reference.",
      heading: "We have your brief",
      paragraphs: [
        `Hello${person ? ` ${person.split(" ")[0]}` : ""},`,
        "Thank you — everything you told us has been saved. Quote this reference if you get in touch about it:",
        submission.reference,
        "We will read it properly, look at anything you already have online, and come back to you with a written proposal — what we would build and what it would cost. Nothing is charged before you have agreed it.",
      ],
      footerNote: "Reply to this email if you want to add anything.",
      logoUrl: brand.logoUrl,
      appUrl: brand.appUrl,
      supportEmail: brand.supportEmail,
    });
    try {
      await email.send({ to: customerEmail, from, subject: "We have your brief", text, html });
      result.customer = "sent";
    } catch {
      result.customer = "failed";
    }
  }

  return result;
}
