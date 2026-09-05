import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import { ukDateRange } from "../tasks/dates.js";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext, supportEmailFor } from "../config.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The ceiling on a report body, in characters.
 *
 * `ad_reports.summary_md` is unbounded `text`, and its usual author is the Ad
 * Performance Sentinel — an LLM, whose output length nothing downstream
 * constrains. A run that loops or pastes a whole metrics dump would write a
 * row every admin and portal screen then renders as Markdown, and email as the
 * body of a client-facing message. 20,000 characters is roughly ten pages:
 * far more than any monthly summary needs, and small enough that a runaway
 * generation is refused at the boundary rather than stored.
 */
export const MAX_AD_REPORT_SUMMARY_CHARS = 20_000;

export const SaveDraftAdReportInput = z.object({
  adAccountId: z.string().uuid(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  summaryMd: z.string().min(1).max(MAX_AD_REPORT_SUMMARY_CHARS),
  agentRunId: z.string().uuid().optional(),
});
export type SaveDraftAdReportInput = z.input<typeof SaveDraftAdReportInput>;

export async function saveDraftAdReport(db: Db, organisationId: string, input: SaveDraftAdReportInput) {
  const v = SaveDraftAdReportInput.parse(input);
  await assertOwned(db, organisationId, schema.adAccounts, v.adAccountId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [report] = await tx.insert(schema.adReports).values({
      organisationId,
      adAccountId: v.adAccountId,
      periodStart: v.periodStart,
      periodEnd: v.periodEnd,
      summaryMd: v.summaryMd,
      status: "draft",
      agentRunId: v.agentRunId ?? null,
    }).returning();
    await recordAudit(inner, organisationId, {
      actorKind: v.agentRunId ? "agent" : "user", action: "ad_report.drafted",
      targetType: "ad_report", targetId: report!.id, after: report,
    });
    return report!;
  });
}

export const AdReportActionInput = z.object({
  adReportId: z.string().uuid(),
  actorId: z.string().min(1),
  // Who acted. A staff member sending by hand is the default; the Sentinel's
  // approval-gated tool passes "agent" so the audit trail names the agent that
  // ran rather than attributing its send to a person.
  actorKind: z.enum(["user", "agent"]).default("user"),
});
export type AdReportActionInput = z.input<typeof AdReportActionInput>;

export async function approveAdReport(db: Db, organisationId: string, input: AdReportActionInput) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.adReports)
      .where(and(eq(schema.adReports.id, v.adReportId), eq(schema.adReports.organisationId, organisationId)));
    // A sent report is a fact, not a draft state — approving it again would
    // suggest it could still be re-sent, which sendAdReport's own idempotency
    // guard would then have to contradict.
    if (before?.status === "sent") throw new Error(`ad report ${v.adReportId} has already been sent`);
    // `assertOwned` above already refused another organisation's report; the
    // predicate here is so the statement self-guards, per CLAUDE.md rule 1.
    const [after] = await tx.update(schema.adReports)
      .set({ status: "approved", updatedAt: new Date() })
      .where(and(eq(schema.adReports.id, v.adReportId), eq(schema.adReports.organisationId, organisationId)))
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "ad_report.approved",
      targetType: "ad_report", targetId: v.adReportId, before, after,
    });
    return after!;
  });
}

interface AdReportRecipient {
  clientId: string;
  clientName: string;
  clientEmail: string;
  accountName: string;
}

type AdReportRow = typeof schema.adReports.$inferSelect;

/**
 * Sends an already-approved report. Either a staff member sending by hand, or
 * the Sentinel's `reports_send_to_client` once a human approved that tool call
 * — `actorKind` says which, and the send is audited rather than queued.
 *
 * **The guarantee is: at most one email per report.** The status flip is the
 * claim — `UPDATE ... SET status = 'sent' WHERE id = ? AND organisation_id = ?
 * AND status = 'approved'` — so of two concurrent calls (or a retry racing the
 * first attempt) only one gets a row back. A report already `sent` is not an
 * error: it returns the existing row with `alreadySent: true` so an
 * approval-resume path or a doubled button click can treat it as a no-op.
 *
 * The email is sent **after** the claim transaction commits, never inside it.
 * That is the whole point of the split: a transaction that wraps the send is
 * rolled back by a *killed process* just as readily as by a throwing adapter,
 * and a process killed between `email.send()` and COMMIT leaves the client
 * holding the report while Postgres says `approved` — inviting a second, manual
 * send of the same report. So the claim, the audit row and the activity row are
 * durable before a single byte reaches the mail provider, and the claim is
 * deliberately *not* rolled back when the send fails: rolling it back would
 * re-arm a second email for the same report.
 *
 * A failed send therefore needs a person to look at it, and is recorded rather
 * than hidden — an `ad_report.send_failed` activity on the client timeline, an
 * owner notification and `metadata.lastSendError` on the report — before the
 * error is rethrown. Everything the send *needs* (the account, the client, an
 * address to send to) is validated inside the claim transaction instead, so a
 * report that could never have been emailed stays `approved` and retryable.
 *
 * `metadata.emailedAt` is written in a second, small transaction once the
 * provider has accepted the message. A report `sent` with no `emailedAt` more
 * than a few minutes old is therefore a one-line query for "claimed but never
 * confirmed delivered" — the state a crash between COMMIT and `email.send()`
 * leaves behind, which is otherwise indistinguishable from a clean send.
 *
 * `metadata.sendHistory` appends who sent it and when, every time. There is no
 * approval id on it: this path is reached both from `/ads/reports` (no
 * approval) and from the kernel's resume (which does not pass the approval id
 * down to the tool), so the actor is what the record can honestly carry.
 *
 * `sentMessageId` is left null: this path calls the adapter directly rather
 * than going through the `messages` outbox `sendQueuedMessage` owns, so no
 * `messages` row exists to point at.
 *
 * `env` follows the same convention as `sendQueuedMessage`: the envelope
 * sender is the verified `MAIL_FROM` when set, falling back to a
 * `reports@<SUPPORT_EMAIL_DOMAIN>` identity so tests and local dev work unset.
 */
export async function sendAdReport(
  db: Db,
  organisationId: string,
  input: AdReportActionInput,
  email: EmailAdapter,
  portalBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);

  const claim = await claimAdReport(db, organisationId, v);
  if (claim.alreadySent) return { ...claim.report, alreadySent: true as const };

  const { report, recipient } = claim;
  const link = `${portalBaseUrl.replace(/\/$/, "")}/portal/reports`;
  const from = env.MAIL_FROM ?? supportEmailFor("reports", env);
  const brand = brandEmailContext(env);
  const period = ukDateRange(report.periodStart, report.periodEnd);
  // The account and client names come off records somebody typed; the summary
  // itself — the one piece of model output in this flow — stays in the portal
  // and never reaches the email. Both names are escaped by the template anyway.
  const { text, html } = renderBrandedEmail({
    preheader: `${period}.`,
    heading: `Your ${recipient.accountName} advertising summary`,
    paragraphs: [
      `Hello ${recipient.clientName},`,
      `Your advertising summary for ${period} is ready in your portal.`,
    ],
    cta: { label: "View the report", url: link },
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });
  try {
    await email.send({
      to: recipient.clientEmail,
      from,
      subject: `Your ${recipient.accountName} advertising summary`,
      text,
      html,
    });
  } catch (error) {
    await recordSendFailure(db, organisationId, report, recipient, error).catch((bookkeeping: unknown) => {
      throw new AggregateError(
        [error, bookkeeping],
        `ad report ${report.id} failed to send and the failure could not be recorded`,
      );
    });
    throw error;
  }

  await confirmSend(db, organisationId, report.id);
  return report;
}

type AdReportClaim =
  | { alreadySent: true; report: AdReportRow }
  | { alreadySent: false; report: AdReportRow; recipient: AdReportRecipient };

/**
 * Claims the report and records the send, or reports that it has already gone.
 * Everything here commits together, before the provider is called: the claim is
 * never durable without its audit and activity rows.
 *
 * The recipient is resolved *inside* the transaction so a broken account
 * reference or a client with no address rolls the claim back and leaves the
 * report `approved` — those are conditions a retry can fix, unlike a message
 * already handed to the mail server.
 */
async function claimAdReport(db: Db, organisationId: string, v: z.output<typeof AdReportActionInput>): Promise<AdReportClaim> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.adReports)
      .where(and(eq(schema.adReports.id, v.adReportId), eq(schema.adReports.organisationId, organisationId)));
    if (before?.status === "sent") return { alreadySent: true as const, report: before };

    const historyEntry = JSON.stringify({ at: now.toISOString(), actorId: v.actorId, actorKind: v.actorKind });
    const [claimed] = await tx.update(schema.adReports)
      .set({
        status: "sent",
        sentAt: now,
        // `sendHistory` is append-only: who released this report, and when.
        metadata: sql`coalesce(${schema.adReports.metadata}, '{}'::jsonb)
          || jsonb_build_object('sendHistory', coalesce(${schema.adReports.metadata}->'sendHistory', '[]'::jsonb) || ${historyEntry}::jsonb)`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.adReports.id, v.adReportId),
        eq(schema.adReports.organisationId, organisationId),
        eq(schema.adReports.status, "approved"),
      ))
      .returning();
    if (!claimed) throw new Error(`ad report ${v.adReportId} is not approved (status: ${before?.status ?? "unknown"})`);

    const [context] = await tx.select({
      clientId: schema.adAccounts.clientId,
      clientName: schema.clients.name,
      clientEmail: schema.clients.email,
      accountName: schema.adAccounts.name,
    })
      .from(schema.adAccounts)
      .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
      .where(and(
        eq(schema.adAccounts.id, claimed.adAccountId),
        eq(schema.adAccounts.organisationId, organisationId),
      ));
    // Throwing here rolls the claim above back with it — the report never
    // could have been emailed, so it stays `approved` for a retry.
    if (!context) throw new Error(`ad account ${claimed.adAccountId} not found for report ${v.adReportId}`);
    if (!context.clientEmail) throw new Error(`client ${context.clientId} has no email address for the ads report`);

    await recordAudit(inner, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "ad_report.sent",
      targetType: "ad_report", targetId: v.adReportId, before, after: claimed,
    });
    await recordActivity(inner, organisationId, {
      clientId: context.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "ad_report.sent",
      title: `Ads report for ${context.accountName} sent`, link: `/ads/${claimed.adAccountId}`,
    });
    return {
      alreadySent: false as const,
      report: claimed,
      recipient: { ...context, clientEmail: context.clientEmail },
    };
  });
}

/**
 * Stamps `metadata.emailedAt` now the provider has taken the message. Failing
 * to write it is deliberately not fatal: the email has already gone, so
 * throwing here would tell the operator the send failed and invite a second
 * one. The report simply keeps the "sent but unconfirmed" shape a crash at this
 * point would leave — which is exactly what the field exists to represent.
 */
async function confirmSend(db: Db, organisationId: string, adReportId: string): Promise<void> {
  const confirmation = { emailedAt: new Date().toISOString() };
  await db.update(schema.adReports)
    .set({
      metadata: sql`coalesce(${schema.adReports.metadata}, '{}'::jsonb) || ${JSON.stringify(confirmation)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.adReports.id, adReportId), eq(schema.adReports.organisationId, organisationId)))
    .catch(() => undefined);
}

/**
 * A send that failed after the claim committed. The claim stays taken on
 * purpose (see the `sendAdReport` doc comment), so this is what makes the gap
 * visible: the report carries a `lastSendError` and no `emailedAt`, the client
 * timeline says the email did not go, and the owner is told.
 */
async function recordSendFailure(
  db: Db,
  organisationId: string,
  report: AdReportRow,
  recipient: AdReportRecipient,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lastSendError = { at: new Date().toISOString(), to: recipient.clientEmail, message };
  await db.update(schema.adReports)
    .set({
      metadata: sql`coalesce(${schema.adReports.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastSendError })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.adReports.id, report.id), eq(schema.adReports.organisationId, organisationId)));
  await recordActivity(db, organisationId, {
    clientId: recipient.clientId, actorKind: "system", kind: "ad_report.send_failed",
    title: `Ads report for ${recipient.accountName} was not emailed to ${recipient.clientEmail}`,
    body: `${message}\n\nThe report is marked sent so it cannot go out twice. Check the address and send a fresh report if the client still needs it.`,
    link: `/ads/${report.adAccountId}`,
  });
  await notifyOwner(db, organisationId, {
    kind: "ad_report.send_failed",
    title: `An advertising report was not emailed to ${recipient.clientName}`,
    body: `Sending the ${report.periodStart} to ${report.periodEnd} report to ${recipient.clientEmail} failed: ${message}`,
    link: `/ads/${report.adAccountId}`,
  });
}
