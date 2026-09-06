import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, count, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { findOwnerUserId } from "../tasks/assignee.js";
import { FINISHED_STATUSES } from "../tasks/update-task-status.js";
import { resolvePermissions, type PermissionKey } from "../team/permissions.js";
import { OPEN_TICKET_STATUSES } from "../team/team-health.js";
import { ASSIGNMENT_METADATA_KEY, getAssignmentRules, type AssignmentRules } from "./rules.js";

/** Task kinds that are content work — routed only to members with the `content` permission. */
export const CONTENT_TASK_KINDS = ["content", "social", "gbp", "seo"] as const;

export const PickAssigneeInput = z.object({
  area: z.enum(["support", "tasks"]),
  /** Tasks only: the template's `defaultAssigneeRole`. `any` (the default) considers everyone. */
  role: z.enum(["owner", "staff", "any"]).default("any"),
  /** Tasks only: content kinds are limited to members with the `content` permission. */
  taskKind: z.enum(schema.taskKindEnum.enumValues).optional(),
  /** Override the stored rules (tests, a dry run). Defaults to the organisation's. */
  rules: z.object({
    support: z.enum(["off", "round_robin", "least_open", "clocked_in_least_open"]),
    tasks: z.enum(["off", "by_role_least_open"]),
  }).optional(),
});
export type PickAssigneeInput = z.input<typeof PickAssigneeInput>;

interface Candidate {
  userId: string;
  role: "owner" | "staff";
  createdAt: Date;
  memberId: string;
  open: number;
  clockedIn: boolean;
}

/** The permission a candidate must hold for this pick, or null when any active member will do. */
function permissionFor(area: "support" | "tasks", taskKind: string | undefined): PermissionKey | null {
  if (area === "support") return "support";
  return taskKind && (CONTENT_TASK_KINDS as readonly string[]).includes(taskKind) ? "content" : null;
}

async function candidates(db: Db, organisationId: string, v: z.output<typeof PickAssigneeInput>): Promise<Candidate[]> {
  const members = await db
    .select({
      memberId: schema.organisationMembers.id,
      userId: schema.organisationMembers.userId,
      role: schema.organisationMembers.role,
      createdAt: schema.organisationMembers.createdAt,
      permissions: schema.organisationMembers.permissions,
    })
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.status, "active")))
    .orderBy(asc(schema.organisationMembers.createdAt), asc(schema.organisationMembers.id));
  if (members.length === 0) return [];

  const needed = permissionFor(v.area, v.taskKind);
  const eligible = members.filter((m) => {
    if (v.area === "tasks" && v.role !== "any" && m.role !== v.role) return false;
    return needed === null || resolvePermissions(m.role, m.permissions)[needed];
  });
  if (eligible.length === 0) return [];
  const userIds = eligible.map((m) => m.userId);

  const openRows = v.area === "support"
    ? await db
        .select({ userId: schema.tickets.assignedUserId, open: count() })
        .from(schema.tickets)
        .where(and(
          eq(schema.tickets.organisationId, organisationId),
          inArray(schema.tickets.assignedUserId, userIds),
          inArray(schema.tickets.status, [...OPEN_TICKET_STATUSES]),
          isNull(schema.tickets.deletedAt),
        ))
        .groupBy(schema.tickets.assignedUserId)
    : await db
        .select({ userId: schema.tasks.assigneeUserId, open: count() })
        .from(schema.tasks)
        .where(and(
          eq(schema.tasks.organisationId, organisationId),
          inArray(schema.tasks.assigneeUserId, userIds),
          notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
          isNull(schema.tasks.deletedAt),
        ))
        .groupBy(schema.tasks.assigneeUserId);
  const open = new Map(openRows.map((r) => [r.userId, r.open]));

  const running = await db
    .select({ userId: schema.timeEntries.userId })
    .from(schema.timeEntries)
    .where(and(
      eq(schema.timeEntries.organisationId, organisationId),
      inArray(schema.timeEntries.userId, userIds),
      isNull(schema.timeEntries.endedAt),
    ));
  const clockedIn = new Set(running.map((r) => r.userId));

  return eligible.map((m) => ({
    userId: m.userId, role: m.role, createdAt: m.createdAt, memberId: m.memberId,
    open: open.get(m.userId) ?? 0, clockedIn: clockedIn.has(m.userId),
  }));
}

/** Fewest open first; ties go to staff before the owner, then the oldest membership. Deterministic. */
function leastOpen(list: Candidate[]): Candidate | undefined {
  return [...list].sort((a, b) =>
    a.open - b.open
    || (a.role === b.role ? 0 : a.role === "staff" ? -1 : 1)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a.memberId.localeCompare(b.memberId),
  )[0];
}

/** The candidate after the cursor in membership order, wrapping; the first when the cursor is unknown. */
function nextInTurn(list: Candidate[], cursor: string | undefined): Candidate | undefined {
  if (list.length === 0) return undefined;
  const index = cursor ? list.findIndex((c) => c.userId === cursor) : -1;
  return list[(index + 1) % list.length];
}

/** Where the round-robin cursor is kept: `metadata.assignment.cursor.support`. */
export async function roundRobinCursor(db: Db, organisationId: string, area: "support" | "tasks"): Promise<string | undefined> {
  const [organisation] = await db
    .select({ metadata: schema.organisations.metadata })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  const assignment = organisation?.metadata[ASSIGNMENT_METADATA_KEY];
  const cursor = typeof assignment === "object" && assignment !== null ? (assignment as { cursor?: Record<string, unknown> }).cursor?.[area] : undefined;
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Who should take the next piece of work, or null when the rule for that
 * area is off. With the rule on and nobody eligible (no member with the
 * permission, no staff member for a `staff` template) the owner is the
 * fallback — work must never land on nobody.
 *
 * Reads only; the round-robin cursor is advanced by `autoAssignTicket`, so a
 * dry run does not move the queue.
 */
export async function pickAssignee(db: Db, organisationId: string, input: PickAssigneeInput): Promise<string | null> {
  const v = PickAssigneeInput.parse(input);
  const rules: AssignmentRules = v.rules ?? (await getAssignmentRules(db, organisationId));
  const rule = v.area === "support" ? rules.support : rules.tasks;
  if (rule === "off") return null;

  const list = await candidates(db, organisationId, v);
  let chosen: Candidate | undefined;
  if (rule === "round_robin") {
    chosen = nextInTurn(list, await roundRobinCursor(db, organisationId, v.area));
  } else if (rule === "clocked_in_least_open") {
    const present = list.filter((c) => c.clockedIn);
    chosen = leastOpen(present.length > 0 ? present : list);
  } else {
    chosen = leastOpen(list);
  }
  return chosen?.userId ?? (await findOwnerUserId(db, organisationId));
}
