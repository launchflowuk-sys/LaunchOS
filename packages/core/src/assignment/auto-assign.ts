import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { notify } from "../notifications/notify.js";
import { assignTicket } from "../support/assign-ticket.js";
import { assignTask } from "../tasks/assign-task.js";
import { pickAssignee } from "./pick-assignee.js";
import { ASSIGNMENT_METADATA_KEY, getAssignmentRules } from "./rules.js";

export { supportAssignmentOn, taskAssignmentOn } from "./rules.js";

const Actor = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export interface AutoAssignment {
  assignedUserId: string;
}

/** Remembers who got the last case, so the next round-robin pick moves on. */
async function advanceCursor(db: Db, organisationId: string, area: "support" | "tasks", userId: string): Promise<void> {
  const cursor = JSON.stringify({ cursor: { [area]: userId } });
  await db
    .update(schema.organisations)
    .set({
      metadata: sql`coalesce(${schema.organisations.metadata}, '{}'::jsonb)
        || jsonb_build_object(${ASSIGNMENT_METADATA_KEY}::text,
             coalesce(${schema.organisations.metadata}->${ASSIGNMENT_METADATA_KEY}, '{}'::jsonb)
             || jsonb_build_object('cursor', coalesce(${schema.organisations.metadata}->${ASSIGNMENT_METADATA_KEY}->'cursor', '{}'::jsonb) || (${cursor}::jsonb->'cursor')))`,
      updatedAt: new Date(),
    })
    .where(eq(schema.organisations.id, organisationId));
}

export const AutoAssignTicketInput = z.object({ ticketId: z.string().uuid(), ...Actor });
export type AutoAssignTicketInput = z.input<typeof AutoAssignTicketInput>;

/**
 * Routes a new case by the organisation's support rule. A no-op (null) when
 * the rule is off, when the case already has an assignee, or when nobody at
 * all could be found. Goes through `assignTicket` so the `assigned` event and
 * the audit row are the same ones a manual assignment writes, then tells the
 * assignee. Called from `createTicketInTx` inside the creating transaction.
 */
export async function autoAssignTicket(db: Db, organisationId: string, input: AutoAssignTicketInput): Promise<AutoAssignment | null> {
  const v = AutoAssignTicketInput.parse(input);
  const rules = await getAssignmentRules(db, organisationId);
  if (rules.support === "off") return null;
  const [ticket] = await db
    .select({ id: schema.tickets.id, subject: schema.tickets.subject, assignedUserId: schema.tickets.assignedUserId })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId)));
  if (!ticket) throw new Error(`ticket ${v.ticketId} not found in organisation`);
  if (ticket.assignedUserId) return null;

  const assignedUserId = await pickAssignee(db, organisationId, { area: "support", rules });
  if (!assignedUserId) return null;

  await assignTicket(db, organisationId, { ticketId: ticket.id, assignedUserId, actorKind: v.actorKind, actorId: v.actorId });
  if (rules.support === "round_robin") await advanceCursor(db, organisationId, "support", assignedUserId);
  await notify(db, organisationId, {
    userId: assignedUserId,
    kind: "ticket.assigned",
    title: `Assigned to you: ${ticket.subject.slice(0, 150)}`,
    body: `Routed by the organisation's "${rules.support.replaceAll("_", " ")}" rule.`,
    link: `/cases/${ticket.id}`,
  });
  return { assignedUserId };
}

export const AutoAssignTaskInput = z.object({
  taskId: z.string().uuid(),
  role: z.enum(["owner", "staff", "any"]).default("any"),
  ...Actor,
});
export type AutoAssignTaskInput = z.input<typeof AutoAssignTaskInput>;

/**
 * Routes a generated task by the organisation's task rule — the template's
 * role narrows the candidates, the task's kind decides whether the `content`
 * permission is needed. A no-op when the rule is off or the task is already
 * assigned. `assignTask` writes the audit row and the timeline entry and
 * notifies the assignee.
 */
export async function autoAssignTask(db: Db, organisationId: string, input: AutoAssignTaskInput): Promise<AutoAssignment | null> {
  const v = AutoAssignTaskInput.parse(input);
  const rules = await getAssignmentRules(db, organisationId);
  if (rules.tasks === "off") return null;
  const [task] = await db
    .select({ id: schema.tasks.id, kind: schema.tasks.kind, assigneeUserId: schema.tasks.assigneeUserId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId)));
  if (!task) throw new Error(`task ${v.taskId} not found in organisation`);
  if (task.assigneeUserId) return null;

  const assigneeUserId = await pickAssignee(db, organisationId, { area: "tasks", role: v.role, taskKind: task.kind, rules });
  if (!assigneeUserId) return null;

  await assignTask(db, organisationId, { taskId: task.id, assigneeUserId, actorKind: v.actorKind, actorId: v.actorId });
  return { assignedUserId: assigneeUserId };
}
