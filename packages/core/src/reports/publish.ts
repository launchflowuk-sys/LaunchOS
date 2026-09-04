import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
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
 * audit or activity row.
 *
 * The claim is the UPDATE itself — `WHERE id = ? AND organisation_id = ? AND
 * status <> 'published'` — not a SELECT followed by an unconditional UPDATE.
 * Postgres re-evaluates that predicate against the *committed* row after any
 * concurrent writer's lock is released, so of two racing publishes (a
 * double-clicked button, an approval-resume path retrying while the first
 * request is in flight) exactly one matches a row; the loser's `.returning()`
 * comes back empty and it takes the no-op path with no audit and no activity
 * written. Everything runs in one transaction so a crash between the update
 * and its audit trail can never leave one without the other.
 *
 * `before` is not re-read: the update only fires on a row whose status was not
 * `published`, and `draft` is the only other value the enum allows, so the
 * prior status is known from the statement itself rather than from a second,
 * racy SELECT.
 */
export async function publishClientReport(db: Db, organisationId: string, input: PublishClientReportInput) {
  const v = PublishClientReportInput.parse(input);

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await assertOwned(tx, organisationId, schema.clientReports, v.reportId);

    const [after] = await tx.update(schema.clientReports)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.clientReports.id, v.reportId),
        eq(schema.clientReports.organisationId, organisationId),
        ne(schema.clientReports.status, "published"),
      ))
      .returning();

    if (!after) {
      const [existing] = await tx.select().from(schema.clientReports).where(and(
        eq(schema.clientReports.id, v.reportId),
        eq(schema.clientReports.organisationId, organisationId),
      ));
      return existing!;
    }

    // Only what the RETURNING contract actually proves about the prior state:
    // the update fired, so the row was not `published`, and `draft` is the only
    // other value `client_report_status` allows.
    const before = { id: after.id, status: "draft" as const };
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "client_report.published",
      targetType: "client_report", targetId: v.reportId, before, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: after.clientId, actorKind: "user", actorId: v.actorId, kind: "client_report.published",
      title: `Report for ${after.periodStart} published`, link: `/reports/${after.id}`,
    });
    return after;
  });
}
