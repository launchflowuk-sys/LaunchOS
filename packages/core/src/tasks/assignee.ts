import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, count, desc, eq, notInArray, sql } from "drizzle-orm";
import { FINISHED_STATUSES } from "./update-task-status.js";

/** The oldest active owner. Templates with `default_assignee_role: "owner"` land here. */
export async function findOwnerUserId(db: Db, organisationId: string): Promise<string | null> {
  const [row] = await db.select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.role, "owner"),
      eq(schema.organisationMembers.status, "active"),
    ))
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * The active member with the fewest unfinished tasks. Owners are candidates
 * too — in a one-person agency Shoji is the only member — but a tie prefers
 * `staff` over `owner` so routine work lands on staff first and the owner is
 * only the fallback. Further ties go to the oldest membership, then the
 * membership id: `created_at` is frozen for the whole transaction in Postgres,
 * so two members seeded together compare equal and need a real tiebreaker to
 * stay deterministic. P4's Support Triage `tickets_assign` tool calls this.
 */
export async function pickLeastLoadedStaff(db: Db, organisationId: string): Promise<string | null> {
  const [row] = await db.select({
    userId: schema.organisationMembers.userId,
    load: count(schema.tasks.id),
  })
    .from(schema.organisationMembers)
    .leftJoin(schema.tasks, and(
      eq(schema.tasks.assigneeUserId, schema.organisationMembers.userId),
      eq(schema.tasks.organisationId, organisationId),
      notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
    ))
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.status, "active"),
    ))
    .groupBy(schema.organisationMembers.id, schema.organisationMembers.userId, schema.organisationMembers.role, schema.organisationMembers.createdAt)
    .orderBy(
      sql`count(${schema.tasks.id}) asc`,
      desc(schema.organisationMembers.role),
      asc(schema.organisationMembers.createdAt),
      asc(schema.organisationMembers.id),
    )
    .limit(1);
  return row?.userId ?? null;
}
