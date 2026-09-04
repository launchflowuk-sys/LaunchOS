import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { TaskKind, TaskPhase, TaskPriority, TaskStatus } from "@launchos/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";

export const TaskFilters = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: z.array(z.enum(schema.taskStatusEnum.enumValues)).min(1).optional(),
  /** A user id, or the literal "unassigned". */
  assigneeUserId: z.string().min(1).optional(),
  phase: z.enum(schema.taskPhaseEnum.enumValues).optional(),
  kind: z.enum(schema.taskKindEnum.enumValues).optional(),
  dueFrom: z.coerce.date().optional(),
  dueTo: z.coerce.date().optional(),
  clientVisible: z.boolean().optional(),
  /**
   * "due" — soonest due first, undated last. Right for a per-client or per-
   * phase view, where the order mirrors the plan of work.
   *
   * "recent" — newest first. Right for an unfiltered cross-client list, where
   * the rows are capped by `limit`: under "due" a task with no due date sorts
   * behind every dated one and then behind every older undated one, so a task
   * that was just created falls off the end of the page and looks as though it
   * was never written.
   */
  sort: z.enum(["due", "recent"]).default("due"),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});
export type TaskFilters = z.input<typeof TaskFilters>;

export type TaskListRow = {
  id: string;
  title: string;
  phase: TaskPhase;
  kind: TaskKind;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Date | null;
  completedAt: Date | null;
  clientVisible: boolean;
  clientId: string;
  clientName: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
};

export async function listTasks(db: Db, organisationId: string, filters: TaskFilters = {}): Promise<TaskListRow[]> {
  const f = TaskFilters.parse(filters);
  const where: SQL[] = [eq(schema.tasks.organisationId, organisationId)];
  if (f.clientId) where.push(eq(schema.tasks.clientId, f.clientId));
  if (f.siteId) where.push(eq(schema.tasks.siteId, f.siteId));
  if (f.status) where.push(inArray(schema.tasks.status, f.status));
  if (f.phase) where.push(eq(schema.tasks.phase, f.phase));
  if (f.kind) where.push(eq(schema.tasks.kind, f.kind));
  if (f.assigneeUserId === "unassigned") where.push(isNull(schema.tasks.assigneeUserId));
  else if (f.assigneeUserId) where.push(eq(schema.tasks.assigneeUserId, f.assigneeUserId));
  if (f.dueFrom) where.push(gte(schema.tasks.dueAt, f.dueFrom));
  if (f.dueTo) where.push(lte(schema.tasks.dueAt, f.dueTo));
  if (f.clientVisible !== undefined) where.push(eq(schema.tasks.clientVisible, f.clientVisible));

  return db.select({
    id: schema.tasks.id,
    title: schema.tasks.title,
    phase: schema.tasks.phase,
    kind: schema.tasks.kind,
    status: schema.tasks.status,
    priority: schema.tasks.priority,
    dueAt: schema.tasks.dueAt,
    completedAt: schema.tasks.completedAt,
    clientVisible: schema.tasks.clientVisible,
    clientId: schema.tasks.clientId,
    clientName: schema.clients.name,
    assigneeUserId: schema.tasks.assigneeUserId,
    assigneeName: schema.organisationMembers.displayName,
  })
    .from(schema.tasks)
    .innerJoin(schema.clients, eq(schema.tasks.clientId, schema.clients.id))
    .leftJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.userId, schema.tasks.assigneeUserId),
        eq(schema.organisationMembers.organisationId, organisationId),
      ),
    )
    .where(and(...where))
    // "due": Postgres sorts NULLs last on ASC, so undated tasks fall to the
    // bottom. "recent": `created_at` is not unique — tasks generated in one
    // transaction share it — so `id` breaks the tie and the page boundary is
    // reproducible rather than merely usually right.
    .orderBy(
      ...(f.sort === "recent"
        ? [desc(schema.tasks.createdAt), desc(schema.tasks.id)]
        : [asc(schema.tasks.dueAt), asc(schema.tasks.createdAt)]),
    )
    .limit(f.limit)
    .offset(f.offset);
}
