import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";

export const ListClientReportsInput = z.object({
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListClientReportsInput = z.input<typeof ListClientReportsInput>;

/** Org-scoped, optionally narrowed to one client, newest period first. */
export async function listClientReports(db: Db, organisationId: string, input: ListClientReportsInput = {}) {
  const v = ListClientReportsInput.parse(input);
  const where: SQL[] = [eq(schema.clientReports.organisationId, organisationId)];
  if (v.clientId) where.push(eq(schema.clientReports.clientId, v.clientId));
  return db.select().from(schema.clientReports)
    .where(and(...where))
    .orderBy(desc(schema.clientReports.periodStart))
    .limit(v.limit);
}

/** The report, scoped to both the organisation and the client it belongs to. */
export async function getClientReport(db: Db, organisationId: string, clientId: string, reportId: string) {
  const [report] = await db.select().from(schema.clientReports).where(and(
    eq(schema.clientReports.id, reportId),
    eq(schema.clientReports.organisationId, organisationId),
    eq(schema.clientReports.clientId, clientId),
  ));
  return report ?? null;
}
