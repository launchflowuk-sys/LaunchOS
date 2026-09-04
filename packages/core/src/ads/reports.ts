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
  const [report] = await db.insert(schema.adReports).values({
    organisationId,
    adAccountId: v.adAccountId,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    summaryMd: v.summaryMd,
    status: "draft",
    agentRunId: v.agentRunId ?? null,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.agentRunId ? "agent" : "user", action: "ad_report.drafted",
    targetType: "ad_report", targetId: report!.id, after: report,
  });
  return report!;
}

export const AdReportActionInput = z.object({
  adReportId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type AdReportActionInput = z.input<typeof AdReportActionInput>;

export async function approveAdReport(db: Db, organisationId: string, input: AdReportActionInput) {
  const v = AdReportActionInput.parse(input);
  await assertOwned(db, organisationId, schema.adReports, v.adReportId);
  const [before] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, v.adReportId));
  const [after] = await db.update(schema.adReports)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(schema.adReports.id, v.adReportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "ad_report.approved",
    targetType: "ad_report", targetId: v.adReportId, before, after,
  });
  return after!;
}

/**
 * A staff member sending an approved report by hand. This is a human action,
 * audited rather than queued — spec §4 reserves the approval gate for the
 * agent's own outward-facing tools.
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
  const [row] = await db.select({
    report: schema.adReports,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
    clientEmail: schema.clients.email,
    accountName: schema.adAccounts.name,
  })
    .from(schema.adReports)
    .innerJoin(schema.adAccounts, eq(schema.adReports.adAccountId, schema.adAccounts.id))
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(eq(schema.adReports.id, v.adReportId), eq(schema.adReports.organisationId, organisationId)));
  if (!row!.clientEmail) throw new Error(`client ${row!.clientId} has no email address for the ads report`);

  const link = `${portalBaseUrl}/portal/reports`;
  const from = env.MAIL_FROM ?? supportEmailFor("reports", env);
  await email.send({
    to: row!.clientEmail,
    from,
    subject: `Your ${row!.accountName} advertising summary`,
    text: `Hello ${row!.clientName},\n\nYour advertising summary for ${row!.report.periodStart} to ${row!.report.periodEnd} is ready in your portal:\n${link}\n\nLaunchFlow`,
  });

  const [after] = await db.update(schema.adReports)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.adReports.id, v.adReportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "ad_report.sent",
    targetType: "ad_report", targetId: v.adReportId, before: row!.report, after,
  });
  await recordActivity(db, organisationId, {
    clientId: row!.clientId, actorKind: "user", actorId: v.actorId, kind: "ad_report.sent",
    title: `Ads report for ${row!.accountName} sent`, link: `/ads/${row!.report.adAccountId}`,
  });
  return after!;
}
