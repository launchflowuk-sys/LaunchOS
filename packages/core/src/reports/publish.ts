import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const PublishClientReportInput = z.object({
  reportId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type PublishClientReportInput = z.input<typeof PublishClientReportInput>;

export async function publishClientReport(db: Db, organisationId: string, input: PublishClientReportInput) {
  const v = PublishClientReportInput.parse(input);
  await assertOwned(db, organisationId, schema.clientReports, v.reportId);
  const [before] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.id, v.reportId));
  const [after] = await db.update(schema.clientReports)
    .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.clientReports.id, v.reportId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "client_report.published",
    targetType: "client_report", targetId: v.reportId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: "user", actorId: v.actorId, kind: "client_report.published",
    title: `Report for ${after!.periodStart} published`, link: `/reports/${after!.id}`,
  });
  return after!;
}
