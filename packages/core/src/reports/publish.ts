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

/**
 * Publishing is a one-way door the client sees the far side of, so a second
 * call for the same report must be a no-op: no `publishedAt` bump, no extra
 * audit or activity row. The read, update, audit and activity all run in one
 * transaction so a crash between them can never leave a published row with
 * no audit trail, or an audit row for an update that never committed.
 */
export async function publishClientReport(db: Db, organisationId: string, input: PublishClientReportInput) {
  const v = PublishClientReportInput.parse(input);
  await assertOwned(db, organisationId, schema.clientReports, v.reportId);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [before] = await t.select().from(schema.clientReports).where(eq(schema.clientReports.id, v.reportId));
    if (before!.status === "published") return before!;

    const [after] = await t.update(schema.clientReports)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.clientReports.id, v.reportId))
      .returning();
    await recordAudit(t, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "client_report.published",
      targetType: "client_report", targetId: v.reportId, before, after,
    });
    await recordActivity(t, organisationId, {
      clientId: after!.clientId, actorKind: "user", actorId: v.actorId, kind: "client_report.published",
      title: `Report for ${after!.periodStart} published`, link: `/reports/${after!.id}`,
    });
    return after!;
  });
}
