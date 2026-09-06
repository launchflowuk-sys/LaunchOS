import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { CSAT_INVITED_AT } from "./invite.js";

export const CsatSummaryInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
  now: z.coerce.date().default(() => new Date()),
});
export type CsatSummaryInput = z.input<typeof CsatSummaryInput>;

export interface CsatScoreLine {
  responses: number;
  /** Mean score to one decimal, null with no responses. */
  average: number | null;
}

export interface CsatMemberSummary extends CsatScoreLine {
  userId: string;
  name: string;
  role: "owner" | "staff";
}

export interface CsatSummary {
  window: { from: Date; to: Date; days: number };
  organisation: CsatScoreLine & {
    /** How many cases were asked in the window, for a response rate. */
    invited: number;
    distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  };
  members: CsatMemberSummary[];
}

function average(sum: number, n: number): number | null {
  return n === 0 ? null : Math.round((sum / n) * 10) / 10;
}

/**
 * CSAT over the last `days`: the organisation line (with a 1–5 distribution
 * and how many cases were invited to rate) and one line per active member,
 * attributed by the case's assignee at the time of rating. Members with no
 * responses are listed with `null`, so the team health table stays complete.
 */
export async function csatSummary(db: Db, organisationId: string, input: CsatSummaryInput = {}): Promise<CsatSummary> {
  const v = CsatSummaryInput.parse(input);
  const to = v.now;
  const from = new Date(to.getTime() - v.days * 86_400_000);
  const inWindow = and(
    eq(schema.ticketRatings.organisationId, organisationId),
    gte(schema.ticketRatings.ratedAt, from),
    lt(schema.ticketRatings.ratedAt, to),
  );

  const ratings = await db
    .select({ score: schema.ticketRatings.score, assignedUserId: schema.tickets.assignedUserId })
    .from(schema.ticketRatings)
    .innerJoin(schema.tickets, eq(schema.ticketRatings.ticketId, schema.tickets.id))
    .where(inWindow);

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  const perMember = new Map<string, { sum: number; n: number }>();
  for (const r of ratings) {
    const score = Math.min(5, Math.max(1, r.score)) as 1 | 2 | 3 | 4 | 5;
    distribution[score] += 1;
    sum += score;
    if (r.assignedUserId) {
      const m = perMember.get(r.assignedUserId) ?? { sum: 0, n: 0 };
      perMember.set(r.assignedUserId, { sum: m.sum + score, n: m.n + 1 });
    }
  }

  const [invitedRow] = await db
    .select({ value: count() })
    .from(schema.tickets)
    .where(and(
      eq(schema.tickets.organisationId, organisationId),
      sql`(${schema.tickets.metadata}->>${CSAT_INVITED_AT})::timestamptz >= ${from.toISOString()}::timestamptz`,
      sql`(${schema.tickets.metadata}->>${CSAT_INVITED_AT})::timestamptz < ${to.toISOString()}::timestamptz`,
    ));

  const members = await db
    .select({
      userId: schema.organisationMembers.userId,
      role: schema.organisationMembers.role,
      displayName: schema.organisationMembers.displayName,
      name: schema.user.name,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.status, "active")))
    // Owner first, then by when they joined; the name breaks a same-transaction
    // tie so the order never depends on a random id.
    .orderBy(
      sql`case when ${schema.organisationMembers.role} = 'owner' then 0 else 1 end`,
      asc(schema.organisationMembers.createdAt),
      asc(schema.user.name),
      asc(schema.organisationMembers.id),
    );

  return {
    window: { from, to, days: v.days },
    organisation: { responses: ratings.length, average: average(sum, ratings.length), invited: invitedRow?.value ?? 0, distribution },
    members: members.map((m) => {
      const line = perMember.get(m.userId) ?? { sum: 0, n: 0 };
      return { userId: m.userId, name: m.displayName ?? m.name, role: m.role, responses: line.n, average: average(line.sum, line.n) };
    }),
  };
}
