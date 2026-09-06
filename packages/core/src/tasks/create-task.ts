import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import {
  assertClientInOrganisation, assertOrgMember, assertOwned, assertSiteBelongsToClient, assertSiteInOrganisation,
} from "../tenancy/assert-owned.js";
import { TaskEvidenceInput } from "./evidence.js";

export const CreateTaskInput = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  kind: z.enum(schema.taskKindEnum.enumValues).default("other"),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  status: z.enum(schema.taskStatusEnum.enumValues).default("todo"),
  priority: z.enum(schema.taskPriorityEnum.enumValues).default("medium"),
  dueAt: z.coerce.date().optional(),
  assigneeUserId: z.string().optional(),
  ticketId: z.string().uuid().optional(),
  descriptionMd: z.string().max(20000).optional(),
  recurrenceKey: z.string().max(120).optional(),
  checklist: z.array(z.object({ label: z.string().min(1).max(200), done: z.boolean().default(false) })).max(50).default([]),
  /** Proof of work; the generators pass `evidenceFromTemplate(template)`. */
  evidence: TaskEvidenceInput.default({ links: [], attachments: [], checklist: [] }),
  clientVisible: z.boolean().default(true),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export async function createTask(db: Db, organisationId: string, input: CreateTaskInput) {
  const v = CreateTaskInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);
  if (v.siteId) {
    await assertSiteInOrganisation(db, organisationId, v.siteId);
    await assertSiteBelongsToClient(db, organisationId, v.siteId, v.clientId);
  }
  if (v.ticketId) await assertOwned(db, organisationId, schema.tickets, v.ticketId);
  if (v.assigneeUserId) {
    // Consistent with assignTask: fold the tenancy error into a message that
    // names the actual constraint, not the generic "not found" wording.
    try {
      await assertOrgMember(db, organisationId, v.assigneeUserId);
    } catch {
      throw new Error(`user ${v.assigneeUserId} is not an active member of this organisation`);
    }
  }

  // One transaction: a task without its audit row or timeline entry is a task
  // nobody can explain later.
  const task = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.tasks).values({
      organisationId,
      clientId: v.clientId,
      siteId: v.siteId ?? null,
      templateId: v.templateId ?? null,
      phase: v.phase,
      kind: v.kind,
      title: v.title,
      descriptionMd: v.descriptionMd ?? null,
      status: v.status,
      priority: v.priority,
      dueAt: v.dueAt ?? null,
      assigneeUserId: v.assigneeUserId ?? null,
      ticketId: v.ticketId ?? null,
      recurrenceKey: v.recurrenceKey ?? null,
      checklist: v.checklist,
      evidence: v.evidence,
      clientVisible: v.clientVisible,
      createdByKind: v.actorKind,
      createdById: v.actorId ?? null,
    }).returning();

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "task.created",
      targetType: "task", targetId: row!.id, after: row,
    });
    await recordActivity(tx as unknown as Db, organisationId, {
      clientId: v.clientId, siteId: v.siteId, actorKind: v.actorKind, actorId: v.actorId,
      kind: "task.created", title: `Task created: ${v.title}`, link: `/tasks/${row!.id}`,
    });
    return row!;
  });

  await emit({ name: "task.created", organisationId, taskId: task.id });
  return task;
}
