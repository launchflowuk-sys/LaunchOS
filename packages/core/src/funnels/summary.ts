import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * How a funnel is actually doing.
 *
 * The number that matters is not completions, it is **contacts**: the share of
 * walks that reached the middle screen and left a name and a number. A funnel
 * where two thirds contact and a third finish is working; one where everybody
 * finishes and nobody contacts has the contact step in the wrong place.
 */

export const FunnelPerformanceInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
  funnelId: z.string().uuid().optional(),
  now: z.date().optional(),
});
export type FunnelPerformanceInput = z.input<typeof FunnelPerformanceInput>;

export interface FunnelPerformance {
  funnelId: string;
  starts: number;
  /** Sessions that reached the contact step. The one that pays. */
  contacts: number;
  completions: number;
  /** Contacts who never answered another question — the visitors the middle contact step exists for. */
  abandonedAfterContact: number;
  averageScore: number;
  bestScore: number;
}

/** Per-funnel counts over the last N days, busiest first. */
export async function funnelPerformance(
  db: Db,
  organisationId: string,
  input: FunnelPerformanceInput = {},
): Promise<{ days: number; since: Date; funnels: FunnelPerformance[] }> {
  const v = FunnelPerformanceInput.parse(input);
  const now = v.now ?? new Date();
  const since = new Date(now.getTime() - v.days * 86_400_000);

  const rows = await db
    .select({
      funnelId: schema.funnelSessions.funnelId,
      starts: count(),
      contacts: sql<number>`count(*) filter (where ${schema.funnelSessions.leadId} is not null)`,
      completions: sql<number>`count(*) filter (where ${schema.funnelSessions.completedAt} is not null)`,
      abandonedAfterContact: sql<number>`count(*) filter (where ${schema.funnelSessions.leadId} is not null and ${schema.funnelSessions.completedAt} is null)`,
      averageScore: sql<number>`coalesce(round(avg(${schema.funnelSessions.score}) filter (where ${schema.funnelSessions.leadId} is not null)), 0)`,
      bestScore: sql<number>`coalesce(max(${schema.funnelSessions.score}), 0)`,
    })
    .from(schema.funnelSessions)
    .where(and(
      eq(schema.funnelSessions.organisationId, organisationId),
      gte(schema.funnelSessions.createdAt, since),
      v.funnelId ? eq(schema.funnelSessions.funnelId, v.funnelId) : undefined,
    ))
    .groupBy(schema.funnelSessions.funnelId)
    .orderBy(desc(count()));

  return {
    days: v.days,
    since,
    funnels: rows.map((row) => ({
      funnelId: row.funnelId,
      starts: Number(row.starts),
      contacts: Number(row.contacts),
      completions: Number(row.completions),
      abandonedAfterContact: Number(row.abandonedAfterContact),
      averageScore: Number(row.averageScore),
      bestScore: Number(row.bestScore),
    })),
  };
}

export type FunnelSessionRow = typeof schema.funnelSessions.$inferSelect;

export const RecentFunnelSessionsInput = z.object({
  funnelId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type RecentFunnelSessionsInput = z.input<typeof RecentFunnelSessionsInput>;

/** The last walks through one funnel, newest first — including the ones that stopped. */
export async function recentFunnelSessions(db: Db, organisationId: string, input: RecentFunnelSessionsInput): Promise<FunnelSessionRow[]> {
  const v = RecentFunnelSessionsInput.parse(input);
  return db.select().from(schema.funnelSessions)
    .where(and(eq(schema.funnelSessions.organisationId, organisationId), eq(schema.funnelSessions.funnelId, v.funnelId)))
    .orderBy(desc(schema.funnelSessions.createdAt), desc(schema.funnelSessions.id))
    .limit(v.limit);
}
