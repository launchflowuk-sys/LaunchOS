import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SaveDraftAdReportInput = z.object({
  adAccountId: z.string().uuid(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  summaryMd: z.string().min(1),
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
});
export type AdReportActionInput = z.input<typeof AdReportActionInput>;

export async function approveAdReport(db: Db, organisationId: string, input: AdReportActionInput) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.adReports).where(eq(schema.adReports.id, v.adReportId));
    // A sent report is a fact, not a draft state — approving it again would
    // suggest it could still be re-sent, which sendAdReport's own idempotency
    // guard would then have to contradict.
    if (before?.status === "sent") throw new Error(`ad report ${v.adReportId} has already been sent`);
    const [after] = await tx.update(schema.adReports)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(schema.adReports.id, v.adReportId))
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "ad_report.approved",
      targetType: "ad_report", targetId: v.adReportId, before, after,
    });
    return after!;
  });
}

/**
 * A staff member sending an approved report by hand. This is a human action,
 * audited rather than queued — spec §4 reserves the approval gate for the
 * agent's own outward-facing tools.
 *
 * The status flip is the claim: `UPDATE ... WHERE status = 'approved'`
 * inside a transaction takes the report only if it is still approved at that
 * instant, so two concurrent calls (or a retry racing the first attempt)
 * cannot both pass and email the client twice. A report already `sent` is
 * not an error — it returns the existing row with `alreadySent: true` so a
 * caller (an approval-resume path, a doubled button click) can treat it as a
 * no-op. The email send happens *after* the claim but still inside the same
 * transaction: if it throws — bad address, provider outage — the whole
 * transaction rolls back, so the report reverts to `approved` rather than
 * being stuck `sent` with no mail actually delivered, and a retry can claim
 * it again.
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

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.adReports).where(eq(schema.adReports.id, v.adReportId));
    if (before?.status === "sent") return { ...before, alreadySent: true as const };

    const [claimed] = await tx.update(schema.adReports)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
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
      .where(eq(schema.adAccounts.id, claimed.adAccountId));
    // Throwing here (and below) rolls back the claim above along with it —
    // see the function doc comment.
    if (!context) throw new Error(`ad account ${claimed.adAccountId} not found for report ${v.adReportId}`);
    if (!context.clientEmail) throw new Error(`client ${context.clientId} has no email address for the ads report`);

    const link = `${portalBaseUrl}/portal/reports`;
    const from = env.MAIL_FROM ?? supportEmailFor("reports", env);
    await email.send({
      to: context.clientEmail,
      from,
      subject: `Your ${context.accountName} advertising summary`,
      text: `Hello ${context.clientName},\n\nYour advertising summary for ${claimed.periodStart} to ${claimed.periodEnd} is ready in your portal:\n${link}\n\nLaunchFlow`,
    });

    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "ad_report.sent",
      targetType: "ad_report", targetId: v.adReportId, before, after: claimed,
    });
    await recordActivity(inner, organisationId, {
      clientId: context.clientId, actorKind: "user", actorId: v.actorId, kind: "ad_report.sent",
      title: `Ads report for ${context.accountName} sent`, link: `/ads/${claimed.adAccountId}`,
    });
    return claimed;
  });
}
