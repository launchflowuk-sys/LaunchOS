import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { signedDocumentUrl } from "../documents/document-link.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { projectUpdateRecipients } from "../projects/update-approval.js";
import { ActorKindSchema } from "../proposals/shared.js";
import { CLIENT_REPORT_NOTICE_KIND } from "../support/courtesy-notice.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { CLIENT_REPORT_TARGET_TYPE, reportMonthName } from "./monthly-report.js";
import { publishClientReportTx } from "./publish.js";

/**
 * The gate in front of a monthly account report.
 *
 * The worker compiles and renders the month on the 1st; **nothing reaches a
 * client until a person has read it.** This is the same mechanism the content
 * report already uses — `content/report-send.ts` — deliberately not a second
 * one: an approval with no run behind it, a payload the card renders from, a
 * bell that reaches the phone, and one apply per decision.
 *
 * Two things differ, and both come from what a client report *is*:
 *
 * 1. **Approving publishes it.** `content_reports` has a `sent` status of its
 *    own; `client_reports` has `draft` and `published`, and published is what
 *    the portal shows. So the send and the publish are the same act, and
 *    `publishClientReportTx`'s conditional UPDATE is the report-level claim —
 *    the same domain-layer guard the payments and proposal paths rely on.
 *    Two cards for one report, both approved, publish once and email once.
 * 2. **The link is minted at send time, not at request time.** The signed
 *    document URL lives seven days; minting it when Shoji presses Approve
 *    means the client gets a week from the day it arrived rather than a week
 *    from the day the cron ran.
 */

/** `approvals.kind` — the enum value that has been on `approval_kind` since 0000. */
export const MONTHLY_REPORT_SEND_KIND = "report_send" as const;
/** `payload.action`, written beside the kind so a card can be routed without reading the enum. */
export const MONTHLY_REPORT_SEND_ACTION = "monthly_report_send";
/**
 * The partial unique index that would keep pending sends to one per report.
 *
 * **Not created yet.** It belongs on `approvals` next to
 * `approvals_pending_content_report_send`, in the same shape:
 *
 * ```
 * uniqueIndex("approvals_pending_monthly_report_send")
 *   .on(t.organisationId, sql`(${t.payload} ->> 'reportId')`)
 *   .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'monthly_report_send'`)
 * ```
 *
 * `packages/db` was held by another task while this landed, so the guard below
 * is a conditional insert instead. The `isUniqueViolation` catch is already
 * written, so adding the index changes nothing here but the failure mode of a
 * true race — from two cards to one refusal.
 */
export const PENDING_MONTHLY_REPORT_SEND_INDEX = "approvals_pending_monthly_report_send";

export type ReportRefusalReason = "not_found" | "already_pending" | "no_recipient";

/** A business answer to a send request, not a fault: the caller decides what it means. */
export class ReportRefused extends Error {
  constructor(readonly reason: ReportRefusalReason, message: string) {
    super(message);
    this.name = "ReportRefused";
  }
}

export const MonthlyReportSendPayload = z.object({
  action: z.literal(MONTHLY_REPORT_SEND_ACTION),
  reportId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  /** `2026-08-01` — the London month the report covers. */
  periodStart: z.string(),
  monthName: z.string(),
  summary: z.string(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type MonthlyReportSendPayload = z.infer<typeof MonthlyReportSendPayload>;

type ApprovalRow = typeof schema.approvals.$inferSelect;
type ClientReportRow = typeof schema.clientReports.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

/** The month a report covers, read the way the business reads it. */
export function monthlyReportMonthName(report: Pick<ClientReportRow, "periodStart" | "periodEnd">): string {
  return reportMonthName({
    start: new Date(`${report.periodStart}T12:00:00Z`),
    end: new Date(`${report.periodEnd}T12:00:00Z`),
  });
}

/** "Send Grays CabLine their August 2026 account report". The card's title. */
export function monthlyReportSendSummary(clientName: string, monthName: string): string {
  return `Send ${clientName} their ${monthName} account report`;
}

/**
 * The stored email body — the record of what the client was told.
 *
 * Short on purpose: the report *is* the PDF, and the shell in
 * `send-queued-message.ts` puts "Open your report" on the button. Repeating
 * the figures here would give a client two versions of August to compare.
 */
export function monthlyReportEmailBody(input: { clientName: string; monthName: string; documentUrl: string | null }): string {
  const lines = [
    `Hello ${input.clientName},`,
    "",
    `Your account report for ${input.monthName} is ready. It is one page: what we did, how your sites held up, what went out, what your advertising returned, and where your invoices stand.`,
  ];
  if (input.documentUrl) lines.push("", `Open it here: ${input.documentUrl}`);
  lines.push("", "Every report we have written for you is on the Reports page of your portal. Reply to this email if anything in it needs explaining and it comes straight to Shoji.");
  return lines.join("\n");
}

/** Whether a send for this report is already waiting for a decision. */
async function pendingSendFor(db: Db, organisationId: string, reportId: string): Promise<ApprovalRow | undefined> {
  const [row] = await db.select().from(schema.approvals).where(and(
    eq(schema.approvals.organisationId, organisationId),
    eq(schema.approvals.status, "pending"),
    sql`${schema.approvals.payload}->>'action' = ${MONTHLY_REPORT_SEND_ACTION}`,
    sql`${schema.approvals.payload}->>'reportId' = ${reportId}`,
  )).limit(1);
  return row;
}

/**
 * Whether the owner has already decided a send for this report.
 *
 * The cron's guard: a rejection leaves the report a draft, and the next tick —
 * a retry, or a manual re-run — must not put the same card back in front of
 * them. Scoped by organisation as well as report id, because every read of a
 * shared table here is.
 */
export async function monthlyReportSendDecided(db: Db, organisationId: string, reportId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
    eq(schema.approvals.organisationId, organisationId),
    ne(schema.approvals.status, "pending"),
    sql`${schema.approvals.payload}->>'action' = ${MONTHLY_REPORT_SEND_ACTION}`,
    sql`${schema.approvals.payload}->>'reportId' = ${reportId}`,
  )).limit(1);
  return row !== undefined;
}

export const RequestMonthlyReportSendInput = z.object({
  reportId: z.string().uuid(),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type RequestMonthlyReportSendInput = z.input<typeof RequestMonthlyReportSendInput>;

/**
 * Asks the owner to send a month's account report to the client.
 *
 * Refused for a report that already has a card waiting (`already_pending`) and
 * for one with nobody to write to (`no_recipient`) — the second checked now
 * rather than after Shoji has approved something that cannot be delivered,
 * exactly as `requestProjectUpdateApproval` does it.
 */
export async function requestMonthlyReportSend(
  db: Db,
  organisationId: string,
  input: RequestMonthlyReportSendInput,
): Promise<{ report: ClientReportRow; approval: ApprovalRow }> {
  const v = RequestMonthlyReportSendInput.parse(input);
  await assertOwned(db, organisationId, schema.clientReports, v.reportId);
  const [report] = await db.select().from(schema.clientReports).where(and(
    eq(schema.clientReports.id, v.reportId),
    eq(schema.clientReports.organisationId, organisationId),
  ));
  if (!report) throw new ReportRefused("not_found", "That report could not be found.");

  const [client] = await db.select({ name: schema.clients.name }).from(schema.clients)
    .where(and(eq(schema.clients.id, report.clientId), eq(schema.clients.organisationId, organisationId)));
  if (!client) throw new ReportRefused("not_found", "That report's client could not be found.");
  const recipients = await projectUpdateRecipients(db, organisationId, report.clientId);
  if (recipients.length === 0) {
    throw new ReportRefused("no_recipient", `There is nobody on ${client.name} with an email address to send their report to.`);
  }

  const existing = await pendingSendFor(db, organisationId, report.id);
  if (existing) throw new ReportRefused("already_pending", "A send for this report is already waiting for a decision.");

  const monthName = monthlyReportMonthName(report);
  const summary = monthlyReportSendSummary(client.name, monthName);
  const payload: MonthlyReportSendPayload = {
    action: MONTHLY_REPORT_SEND_ACTION,
    reportId: report.id,
    clientId: report.clientId,
    clientName: client.name,
    periodStart: report.periodStart,
    monthName,
    summary,
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId, kind: MONTHLY_REPORT_SEND_KIND, title: summary, payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "client_report.send_requested",
        targetType: CLIENT_REPORT_TARGET_TYPE, targetId: report.id, after: row,
      });
      return row!;
    });
  } catch (error) {
    // Once `approvals_pending_monthly_report_send` exists this is the only
    // guard that matters; until then it is unreachable and harmless.
    if (isUniqueViolation(error)) throw new ReportRefused("already_pending", "A send for this report is already waiting for a decision.");
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: "approval.requested",
    title: `Approve: ${client.name}'s ${monthName} account report`,
    body: `One page covering ${monthName}. Approve to publish it and email it to their portal users.`,
    link: "/approvals",
  });
  return { report, approval };
}

export const ApplyMonthlyReportSendDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
});
export type ApplyMonthlyReportSendDecisionInput = z.input<typeof ApplyMonthlyReportSendDecisionInput>;

export interface ApplyMonthlyReportSendDecisionResult {
  decision: "approved" | "rejected";
  reportId: string;
  clientId: string;
  /** The queued emails, one per portal address. Empty on reject. */
  notices: (typeof schema.messages.$inferSelect)[];
  alreadyApplied: boolean;
}

/** Stamped on the approval once carried out — the at-most-once claim. */
const APPLIED_AT = "appliedAt";

/**
 * Carries out a decided monthly report send. Call after `decideApproval`, for
 * both verdicts, exactly as the content report's apply is called.
 *
 * Approved: the report is published (so the portal shows it) and one branded
 * email per portal address is queued on a closed conversation of its own,
 * carrying the signed link to the PDF; the `message.queued` events are emitted
 * after commit. Rejected: the report stays a draft, audited, so it can be
 * rebuilt, corrected and re-requested.
 */
export async function applyMonthlyReportSendDecision(
  db: Db,
  organisationId: string,
  input: ApplyMonthlyReportSendDecisionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyMonthlyReportSendDecisionResult> {
  const v = ApplyMonthlyReportSendDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = MonthlyReportSendPayload.parse(approval.payload);
  await assertOwned(db, organisationId, schema.clientReports, payload.reportId);

  const recipients = decision === "approved" ? await projectUpdateRecipients(db, organisationId, payload.clientId) : [];
  const [identity] = await db.select({ address: schema.emailIdentities.address }).from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, payload.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);
  const subject = `Your account report for ${payload.monthName}`;

  const applied = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    const [claimed] = await tx.update(schema.approvals)
      .set({
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [APPLIED_AT]: now.toISOString(), appliedBy: v.actorId })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, v.approvalId),
        eq(schema.approvals.organisationId, organisationId),
        sql`(${schema.approvals.metadata}->>${APPLIED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return undefined;

    if (decision !== "approved") {
      await recordAudit(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, action: "client_report.send_rejected",
        targetType: CLIENT_REPORT_TARGET_TYPE, targetId: payload.reportId, before: approval, after: claimed,
      });
      return { notices: [] as (typeof schema.messages.$inferSelect)[] };
    }

    // Publishing is what makes the report visible in the portal, and its
    // conditional UPDATE is the report-level claim behind this approval's own.
    const report = await publishClientReportTx(tx, organisationId, { reportId: payload.reportId, actorId: v.actorId });
    // Minted here rather than when the card was raised: seven days from the
    // day it lands in the inbox, not from the day the cron ran.
    const documentUrl = report.documentId
      ? signedDocumentUrl({ organisationId, documentId: report.documentId }, env)
      : null;
    const body = monthlyReportEmailBody({ clientName: payload.clientName, monthName: payload.monthName, documentUrl });

    const notices: (typeof schema.messages.$inferSelect)[] = [];
    if (recipients.length > 0) {
      const [conversation] = await tx.insert(schema.conversations).values({
        organisationId, clientId: payload.clientId, subject, channel: "email", status: "closed", lastMessageAt: now,
      }).returning();
      for (const to of recipients) {
        const [notice] = await tx.insert(schema.messages).values({
          organisationId, conversationId: conversation!.id, direction: "outbound", authorKind: "system", authorId: null,
          body, fromEmail: from, toEmail: to, subject, status: "queued",
          metadata: {
            kind: CLIENT_REPORT_NOTICE_KIND,
            reportId: report.id,
            monthName: payload.monthName,
            approvalId: v.approvalId,
            ...(report.documentId ? { documentId: report.documentId } : {}),
            ...(documentUrl ? { documentUrl } : {}),
          },
        }).returning();
        await recordAudit(tx, organisationId, {
          actorKind: "system", action: "message.queued", targetType: "message", targetId: notice!.id, after: notice,
        });
        notices.push(notice!);
      }
    }
    await recordActivity(tx, organisationId, {
      clientId: payload.clientId, actorKind: "user", actorId: v.actorId, kind: "client_report.sent",
      title: `${payload.monthName} account report sent to ${recipients.length} address${recipients.length === 1 ? "" : "es"}`,
      link: `/reports/${report.id}`,
    });
    return { notices };
  });

  if (!applied) return { decision, reportId: payload.reportId, clientId: payload.clientId, notices: [], alreadyApplied: true };
  for (const notice of applied.notices) await emit({ name: "message.queued", organisationId, messageId: notice.id });
  return { decision, reportId: payload.reportId, clientId: payload.clientId, notices: applied.notices, alreadyApplied: false };
}
