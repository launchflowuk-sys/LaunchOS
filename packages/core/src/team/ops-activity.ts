import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

const HOUR_MS = 3_600_000;

export const RecentOpsActivityInput = z.object({
  hours: z.number().int().min(1).max(24 * 14).default(24),
  limit: z.number().int().min(1).max(100).default(40),
  now: z.coerce.date().default(() => new Date()),
});
export type RecentOpsActivityInput = z.input<typeof RecentOpsActivityInput>;

export interface OpsTimelineItem {
  at: Date;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  clientName: string | null;
  actorKind: string;
}

export interface RecentOpsActivity {
  window: { from: Date; to: Date; hours: number };
  /** The client timelines, newest first — what happened, in words a person wrote. */
  timeline: OpsTimelineItem[];
  /** Every audited action in the window, counted — the machine's own tally of what changed. */
  auditCounts: { action: string; count: number }[];
}

/**
 * What happened in the last day, in the two records that already exist for
 * it: the per-client timeline (`activity_events`) for the narrative and the
 * audit log for the count of everything else. Read-only, and the reason the
 * Ops Brief can name a client or a case without inventing one.
 */
export async function recentOpsActivity(db: Db, organisationId: string, input: RecentOpsActivityInput = {}): Promise<RecentOpsActivity> {
  const v = RecentOpsActivityInput.parse(input);
  const from = new Date(v.now.getTime() - v.hours * HOUR_MS);
  const [events, counts] = await Promise.all([
    db
      .select({
        at: schema.activityEvents.createdAt,
        kind: schema.activityEvents.kind,
        title: schema.activityEvents.title,
        body: schema.activityEvents.body,
        link: schema.activityEvents.link,
        clientName: schema.clients.name,
        actorKind: schema.activityEvents.actorKind,
      })
      .from(schema.activityEvents)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.activityEvents.clientId))
      .where(and(eq(schema.activityEvents.organisationId, organisationId), gte(schema.activityEvents.createdAt, from)))
      .orderBy(desc(schema.activityEvents.createdAt), desc(schema.activityEvents.id))
      .limit(v.limit),
    db
      .select({ action: schema.auditLog.action, count: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.organisationId, organisationId), gte(schema.auditLog.createdAt, from)))
      .groupBy(schema.auditLog.action)
      .orderBy(desc(sql`count(*)`), schema.auditLog.action),
  ]);
  return { window: { from, to: v.now, hours: v.hours }, timeline: events, auditCounts: counts };
}
