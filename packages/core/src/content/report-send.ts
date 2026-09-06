import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentReportStats } from "@launchos/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { CONTENT_REPORT_NOTICE_KIND } from "../support/courtesy-notice.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { ActorKindSchema, CHANNEL_LABEL, ContentRefused, monthName, shortLondonDate, type ContentReportRow } from "./shared.js";

/** `approvals.kind` AND `payload.action` on a content report send. */
export const CONTENT_REPORT_SEND_ACTION = "content_report_send";
/** The partial unique index that keeps pending sends to one per report. */
export const PENDING_CONTENT_REPORT_SEND_INDEX = "approvals_pending_content_report_send";

export const ContentReportSendPayload = z.object({
  action: z.literal(CONTENT_REPORT_SEND_ACTION),
  reportId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  periodKey: z.string(),
  monthName: z.string(),
  published: z.number().int(),
  planned: z.number().int(),
  summary: z.string(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type ContentReportSendPayload = z.infer<typeof ContentReportSendPayload>;

type ApprovalRow = typeof schema.approvals.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

/** "3 of 4 planned posts published for Grays CabLine in September 2026". */
export function contentReportSendSummary(report: Pick<ContentReportRow, "periodKey" | "stats">, clientName: string): string {
  const stats = report.stats as Partial<ContentReportStats>;
  return `Send ${clientName} their ${monthName(report.periodKey)} content report: ${stats.published ?? 0} of ${stats.planned ?? 0} planned posts published`;
}

/**
 * The stored email body — the record of what the client was told. Plain
 * sentences, one line per published post with its link; the branded shell
 * adds the heading and the "See your posts" button.
 */
export function contentReportEmailBody(report: Pick<ContentReportRow, "periodKey" | "stats">, clientName: string): string {
  const stats = report.stats as Partial<ContentReportStats>;
  const month = monthName(report.periodKey);
  const published = stats.published ?? 0;
  const lines = [`Hello ${clientName},`, ""];
  if (published === 0) {
    lines.push(`Nothing went out for you in ${month}. If that is not what you expected, reply on your portal and we will look into it.`);
    return lines.join("\n");
  }
  const byChannel = Object.entries(stats.byChannel ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([channel, n]) => `${n} ${CHANNEL_LABEL[channel as keyof typeof CHANNEL_LABEL].toLowerCase()}${n === 1 ? "" : "s"}`);
  lines.push(`Here is what LaunchFlow published for you in ${month}: ${published} of ${stats.planned ?? published} planned posts${byChannel.length ? ` — ${byChannel.join(", ")}` : ""}.`, "");
  for (const item of stats.items ?? []) {
    const title = item.title ?? CHANNEL_LABEL[item.channel];
    lines.push(`${shortLondonDate(new Date(item.publishedAt))} — ${CHANNEL_LABEL[item.channel]}: ${title}${item.externalUrl ? ` — ${item.externalUrl}` : ""}`);
  }
  lines.push("", "Every post, with its link, is on the Content page of your portal.");
  return lines.join("\n");
}

export const RequestContentReportSendInput = z.object({
  reportId: z.string().uuid(),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type RequestContentReportSendInput = z.input<typeof RequestContentReportSendInput>;

/**
 * Asks the owner to send a month's content report to the client. Emailing a
 * client is outward-facing, so it goes through the approvals queue with no
 * run behind it, like an invoice send. Refused for a report already sent
 * (`ContentRefused("already_sent")`) or one with a decision pending
 * (`"already_pending"`, enforced by the partial unique index). The owner's
 * bell gets an `approval.requested` — urgent, so it reaches the phone.
 */
export async function requestContentReportSend(
  db: Db,
  organisationId: string,
  input: RequestContentReportSendInput,
): Promise<{ report: ContentReportRow; approval: ApprovalRow }> {
  const v = RequestContentReportSendInput.parse(input);
  await assertOwned(db, organisationId, schema.contentReports, v.reportId);
  const [report] = await db.select().from(schema.contentReports)
    .where(and(eq(schema.contentReports.id, v.reportId), eq(schema.contentReports.organisationId, organisationId)));
  if (!report) throw new ContentRefused("not_found", "That content report could not be found.");
  if (report.status === "sent") throw new ContentRefused("already_sent", "This report has already been sent to the client.");
  const [client] = await db.select({ name: schema.clients.name }).from(schema.clients)
    .where(and(eq(schema.clients.id, report.clientId), eq(schema.clients.organisationId, organisationId)));
  const stats = report.stats as Partial<ContentReportStats>;

  const summary = contentReportSendSummary(report, client!.name);
  const payload: ContentReportSendPayload = {
    action: CONTENT_REPORT_SEND_ACTION,
    reportId: report.id,
    clientId: report.clientId,
    clientName: client!.name,
    periodKey: report.periodKey,
    monthName: monthName(report.periodKey),
    published: stats.published ?? 0,
    planned: stats.planned ?? 0,
    summary,
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId, kind: CONTENT_REPORT_SEND_ACTION, title: summary, payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "content_report.send_requested",
        targetType: "content_report", targetId: report.id, after: row,
      });
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ContentRefused("already_pending", "A send for this report is already waiting for a decision.");
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: "approval.requested",
    title: `Approve: ${client!.name}'s ${monthName(report.periodKey)} content report`,
    body: `${stats.published ?? 0} of ${stats.planned ?? 0} planned posts published. Approve to email it to their portal users.`,
    link: "/approvals",
  });
  return { report, approval };
}

export const ApplyContentReportSendDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
});
export type ApplyContentReportSendDecisionInput = z.input<typeof ApplyContentReportSendDecisionInput>;

export interface ApplyContentReportSendDecisionResult {
  decision: "approved" | "rejected";
  reportId: string;
  clientId: string;
  /** The queued emails, one per portal user (or the client's own address). Empty on reject. */
  notices: (typeof schema.messages.$inferSelect)[];
  alreadyApplied: boolean;
}

/** Stamped on the approval once carried out — the at-most-once claim. */
const APPLIED_AT = "appliedAt";

/** Active portal users of the client, falling back to the client's own address. */
async function recipientAddresses(db: Db, organisationId: string, clientId: string): Promise<string[]> {
  const users = await db
    .select({ email: schema.user.email })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.clientId, clientId), eq(schema.clientUsers.status, "active")));
  const addresses = [...new Set(users.map((u) => u.email.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length > 0) return addresses;
  const [client] = await db.select({ email: schema.clients.email }).from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return client?.email ? [client.email] : [];
}

/**
 * Carries out a decided content report send. Call after `decideApproval`,
 * for both verdicts. At most once per approval (`approvals.metadata.appliedAt`
 * claim). Approved: the report is marked `sent` (with `sentAt`) and one
 * branded email per portal user is queued on a closed conversation of its
 * own — `metadata.kind = content_report_notice` — through the same
 * `messages` → `sendQueuedMessage` path every client email takes; the
 * `message.queued` events are emitted after commit. Rejected: the report
 * stays a draft, audited, so it can be rebuilt or re-requested.
 */
export async function applyContentReportSendDecision(
  db: Db,
  organisationId: string,
  input: ApplyContentReportSendDecisionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyContentReportSendDecisionResult> {
  const v = ApplyContentReportSendDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = ContentReportSendPayload.parse(approval.payload);
  await assertOwned(db, organisationId, schema.contentReports, payload.reportId);

  const recipients = decision === "approved" ? await recipientAddresses(db, organisationId, payload.clientId) : [];
  const [identity] = await db.select({ address: schema.emailIdentities.address }).from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, payload.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);

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

    const [before] = await tx.select().from(schema.contentReports)
      .where(and(eq(schema.contentReports.id, payload.reportId), eq(schema.contentReports.organisationId, organisationId)))
      .for("update");
    if (!before) throw new Error(`content report ${payload.reportId} not found in organisation`);

    const notices: (typeof schema.messages.$inferSelect)[] = [];
    if (decision === "approved") {
      const [after] = await tx.update(schema.contentReports)
        .set({ status: "sent", sentAt: now, updatedAt: now })
        .where(eq(schema.contentReports.id, before.id))
        .returning();
      await recordAudit(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, action: "content_report.sent",
        targetType: "content_report", targetId: before.id, before, after,
      });
      await recordActivity(tx, organisationId, {
        clientId: payload.clientId, actorKind: "user", actorId: v.actorId, kind: "content_report.sent",
        title: `${payload.monthName} content report sent to ${recipients.length} address${recipients.length === 1 ? "" : "es"}`,
        link: `/content?client=${payload.clientId}&period=${payload.periodKey}`,
      });
      if (recipients.length > 0) {
        const [conversation] = await tx.insert(schema.conversations).values({
          organisationId, clientId: payload.clientId, subject: `Your content for ${payload.monthName}`,
          channel: "portal", status: "closed", lastMessageAt: now,
        }).returning();
        const body = contentReportEmailBody(before, payload.clientName);
        for (const to of recipients) {
          const [notice] = await tx.insert(schema.messages).values({
            organisationId, conversationId: conversation!.id, direction: "outbound", authorKind: "system", authorId: null,
            body, fromEmail: from, toEmail: to, subject: `Your content for ${payload.monthName}`, status: "queued",
            metadata: { kind: CONTENT_REPORT_NOTICE_KIND, reportId: before.id, monthName: payload.monthName, approvalId: v.approvalId },
          }).returning();
          await recordAudit(tx, organisationId, {
            actorKind: "system", action: "message.queued", targetType: "message", targetId: notice!.id, after: notice,
          });
          notices.push(notice!);
        }
      }
    } else {
      await recordAudit(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, action: "content_report.send_rejected",
        targetType: "content_report", targetId: before.id, before: approval, after: claimed,
      });
    }
    return { notices };
  });

  if (!applied) return { decision, reportId: payload.reportId, clientId: payload.clientId, notices: [], alreadyApplied: true };
  for (const notice of applied.notices) await emit({ name: "message.queued", organisationId, messageId: notice.id });
  return { decision, reportId: payload.reportId, clientId: payload.clientId, notices: applied.notices, alreadyApplied: false };
}
