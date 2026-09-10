import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

/**
 * What the team has been working on.
 *
 * The timesheet says somebody was here for seven hours. It cannot say what
 * those hours went into, so "how is the workload spread" and "what is this
 * person spending their week on" had no answer anywhere.
 *
 * Counted per member, per screen, per day. Not a log of every navigation:
 * that would be tens of thousands of rows a week to answer a question nobody
 * asks at that resolution, and it edges towards surveillance rather than a
 * workload picture. A count per screen per day is enough to see that somebody
 * spent Tuesday in Approvals, and not enough to reconstruct their afternoon.
 *
 * Visible to the person it describes as well as the owner — see the schema
 * comment for why that is not optional.
 */

/** `YYYY-MM-DD` in London, so a "day" is the working day it felt like. */
export function activityDay(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

export interface RecordStaffActivityInput {
  userId: string;
  /** A nav route — `/clients`, never `/clients/8f21…`. The caller normalises. */
  route: string;
  at?: Date | undefined;
}

/**
 * One upsert per view. Cheap enough to run on every navigation, and the unique
 * index does the counting so two tabs cannot race into two rows.
 */
export async function recordStaffActivity(db: Db, organisationId: string, input: RecordStaffActivityInput): Promise<void> {
  const at = input.at ?? new Date();
  const route = input.route.trim().slice(0, 200);
  if (route.length === 0) return;

  await db
    .insert(schema.staffActivity)
    .values({ organisationId, userId: input.userId, route, day: activityDay(at), views: 1, lastAt: at })
    .onConflictDoUpdate({
      target: [
        schema.staffActivity.organisationId,
        schema.staffActivity.userId,
        schema.staffActivity.route,
        schema.staffActivity.day,
      ],
      set: {
        views: sql`${schema.staffActivity.views} + 1`,
        lastAt: at,
        updatedAt: at,
      },
    });
}

export interface ActivityRow {
  userId: string;
  name: string | null;
  email: string;
  route: string;
  views: number;
  lastAt: Date;
}

/**
 * Activity since `since`, busiest first.
 *
 * `userId` narrows it to one person — which is how a staff member reads their
 * own, and how the owner reads somebody's week.
 */
export async function listStaffActivity(
  db: Db,
  organisationId: string,
  since: Date,
  userId?: string,
): Promise<ActivityRow[]> {
  return db
    .select({
      userId: schema.staffActivity.userId,
      name: schema.user.name,
      email: schema.user.email,
      route: schema.staffActivity.route,
      views: schema.staffActivity.views,
      lastAt: schema.staffActivity.lastAt,
    })
    .from(schema.staffActivity)
    .innerJoin(schema.user, eq(schema.user.id, schema.staffActivity.userId))
    .where(and(
      eq(schema.staffActivity.organisationId, organisationId),
      gte(schema.staffActivity.day, activityDay(since)),
      ...(userId ? [eq(schema.staffActivity.userId, userId)] : []),
    ))
    .orderBy(desc(schema.staffActivity.views), desc(schema.staffActivity.lastAt));
}
