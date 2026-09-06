import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import {
  TASK_EVIDENCE_DEFAULT, TASK_EVIDENCE_KINDS, TASK_TEMPLATE_EVIDENCE_DEFAULT,
  type TaskEvidence, type TaskEvidenceAttachment, type TaskTemplateEvidence,
} from "@launchos/db/schema";
import { storeInboundAttachments } from "@launchos/channels";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

type TaskRow = typeof schema.tasks.$inferSelect;

const ActorFields = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
};

/** The template editor's field: what proof a task made from it must carry. */
export const TaskTemplateEvidenceInput = z.object({
  required: z.boolean().default(false),
  kinds: z.array(z.enum(TASK_EVIDENCE_KINDS)).max(TASK_EVIDENCE_KINDS.length).default([]),
  checklist: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
});
export type TaskTemplateEvidenceInput = z.input<typeof TaskTemplateEvidenceInput>;

/** A task's evidence as it may arrive on `createTask` (the generators pass `evidenceFromTemplate`). */
export const TaskEvidenceInput = z.object({
  links: z.array(z.string().url().max(2000)).max(50).default([]),
  attachments: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    contentType: z.string().min(1).max(200),
    size: z.number().int().min(0),
    url: z.string().min(1).max(2000),
    uploadedBy: z.string().optional(),
    uploadedAt: z.string().min(1),
  })).max(50).default([]),
  checklist: z.array(z.object({
    item: z.string().min(1).max(200),
    done: z.boolean().default(false),
    doneBy: z.string().optional(),
    doneAt: z.string().optional(),
  })).max(50).default([]),
});
export type TaskEvidenceInput = z.input<typeof TaskEvidenceInput>;

/** Thrown by `updateTaskStatus` when a task is closed without the proof its template demands. */
export class TaskEvidenceMissing extends Error {
  constructor(readonly taskId: string, readonly missing: string[]) {
    super(`This task cannot be closed yet — still needed: ${missing.join("; ")}.`);
    this.name = "TaskEvidenceMissing";
  }
}

/** The evidence a freshly generated task starts with: the template's proof checklist, unticked. */
export function evidenceFromTemplate(template: { evidence?: TaskTemplateEvidence | null } | null | undefined): TaskEvidence {
  const checklist = template?.evidence?.checklist ?? [];
  return { ...TASK_EVIDENCE_DEFAULT, checklist: checklist.map((item) => ({ item, done: false })) };
}

export interface EvidenceCheck {
  satisfied: boolean;
  /** Human sentences, one per missing thing, for the disabled Done button. */
  missing: string[];
}

/**
 * Pure: whether the task carries what the template asks for. A template with
 * `required: false` (or none at all) is always satisfied. Each kind is checked
 * on its own: `link` wants at least one link, `screenshot` at least one
 * attachment, `checklist` every proof item ticked. The task's own checklist is
 * what counts, not the template's — the template may have changed since the
 * task was generated, and the person doing the work sees the task's list.
 */
export function evidenceSatisfied(
  task: { evidence?: TaskEvidence | null },
  template: { evidence?: TaskTemplateEvidence | null } | null | undefined,
): EvidenceCheck {
  const rule = template?.evidence ?? TASK_TEMPLATE_EVIDENCE_DEFAULT;
  if (!rule.required) return { satisfied: true, missing: [] };
  const evidence = task.evidence ?? TASK_EVIDENCE_DEFAULT;
  const missing: string[] = [];
  if (rule.kinds.includes("link") && evidence.links.length === 0) missing.push("a link to the delivered work");
  if (rule.kinds.includes("screenshot") && evidence.attachments.length === 0) missing.push("a screenshot");
  if (rule.kinds.includes("checklist")) {
    for (const item of evidence.checklist) if (!item.done) missing.push(`tick "${item.item}"`);
  }
  return { satisfied: missing.length === 0, missing };
}

async function loadTask(db: Db, organisationId: string, taskId: string): Promise<TaskRow> {
  const [task] = await db.select().from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.organisationId, organisationId)));
  if (!task) throw new Error(`task ${taskId} not found in organisation`);
  return task;
}

/** The template the task was generated from, for its evidence rule. Null for a hand-made task. */
export async function templateForTask(db: Db, organisationId: string, task: Pick<TaskRow, "templateId">) {
  if (!task.templateId) return null;
  const [template] = await db.select().from(schema.taskTemplates)
    .where(and(eq(schema.taskTemplates.id, task.templateId), eq(schema.taskTemplates.organisationId, organisationId)));
  return template ?? null;
}

/** Loads the rule and throws `TaskEvidenceMissing` when the task may not close yet. */
export async function assertTaskEvidence(db: Db, organisationId: string, task: TaskRow): Promise<void> {
  const template = await templateForTask(db, organisationId, task);
  const check = evidenceSatisfied(task, template);
  if (!check.satisfied) throw new TaskEvidenceMissing(task.id, check.missing);
}

/** What the task page needs in one call: the current evidence, the rule, and what is still missing. */
export async function taskEvidenceStatus(db: Db, organisationId: string, taskId: string) {
  const task = await loadTask(db, organisationId, taskId);
  const template = await templateForTask(db, organisationId, task);
  return { evidence: task.evidence, rule: template?.evidence ?? TASK_TEMPLATE_EVIDENCE_DEFAULT, ...evidenceSatisfied(task, template) };
}

async function writeEvidence(
  db: Db,
  organisationId: string,
  before: TaskRow,
  evidence: TaskEvidence,
  action: string,
  actor: { actorKind: "user" | "client" | "agent" | "system"; actorId?: string | undefined },
): Promise<TaskRow> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.tasks)
      .set({ evidence, updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, before.id), eq(schema.tasks.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: actor.actorKind, actorId: actor.actorId, action, targetType: "task", targetId: before.id,
      before: before.evidence, after: after!.evidence,
    });
    return after!;
  });
}

export const AddTaskEvidenceLinkInput = z.object({ taskId: z.string().uuid(), url: z.string().url().max(2000), ...ActorFields });
export type AddTaskEvidenceLinkInput = z.input<typeof AddTaskEvidenceLinkInput>;

/** Adds a link to the delivered work. The same URL twice is a no-op. */
export async function addTaskEvidenceLink(db: Db, organisationId: string, input: AddTaskEvidenceLinkInput): Promise<TaskRow> {
  const v = AddTaskEvidenceLinkInput.parse(input);
  const before = await loadTask(db, organisationId, v.taskId);
  if (before.evidence.links.includes(v.url)) return before;
  const evidence: TaskEvidence = { ...before.evidence, links: [...before.evidence.links, v.url] };
  return writeEvidence(db, organisationId, before, evidence, "task.evidence_added", v);
}

export const UploadTaskAttachmentInput = z.object({
  taskId: z.string().uuid(),
  name: z.string().min(1).max(200),
  contentType: z.string().min(1).max(200),
  contentBase64: z.string().min(1),
  ...ActorFields,
});
export type UploadTaskAttachmentInput = z.input<typeof UploadTaskAttachmentInput>;

/**
 * Stores a screenshot the way inbound email attachments are stored — under
 * `STORAGE_DIR/attachments/<org>/<uuid>.<ext>`, served by
 * `GET /api/attachments/[org]/[file]` to signed-in staff of that organisation —
 * and records it on the task's evidence. The size cap is the attachments
 * cap (`MAX_ATTACHMENT_BYTES`, 10 MB).
 */
export async function uploadTaskAttachment(
  db: Db,
  organisationId: string,
  input: UploadTaskAttachmentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ task: TaskRow; attachment: TaskEvidenceAttachment }> {
  const v = UploadTaskAttachmentInput.parse(input);
  const before = await loadTask(db, organisationId, v.taskId);
  const [stored] = await storeInboundAttachments(
    organisationId,
    [{ name: v.name, contentType: v.contentType, contentBase64: v.contentBase64 }],
    env,
  );
  const attachment: TaskEvidenceAttachment = {
    id: randomUUID(),
    name: stored!.name,
    contentType: stored!.contentType,
    size: stored!.size,
    url: stored!.url,
    ...(v.actorId ? { uploadedBy: v.actorId } : {}),
    uploadedAt: new Date().toISOString(),
  };
  const evidence: TaskEvidence = { ...before.evidence, attachments: [...before.evidence.attachments, attachment] };
  const task = await writeEvidence(db, organisationId, before, evidence, "task.evidence_added", v);
  return { task, attachment };
}

export const RemoveTaskEvidenceInput = z
  .object({ taskId: z.string().uuid(), url: z.string().optional(), attachmentId: z.string().optional(), ...ActorFields })
  .refine((v) => Boolean(v.url) !== Boolean(v.attachmentId), { message: "pass either url or attachmentId" });
export type RemoveTaskEvidenceInput = z.input<typeof RemoveTaskEvidenceInput>;

/** Takes a link or an attachment off the task. The file itself stays on disk (it may be in the audit trail). */
export async function removeTaskEvidence(db: Db, organisationId: string, input: RemoveTaskEvidenceInput): Promise<TaskRow> {
  const v = RemoveTaskEvidenceInput.parse(input);
  const before = await loadTask(db, organisationId, v.taskId);
  const evidence: TaskEvidence = {
    ...before.evidence,
    links: v.url ? before.evidence.links.filter((l) => l !== v.url) : before.evidence.links,
    attachments: v.attachmentId ? before.evidence.attachments.filter((a) => a.id !== v.attachmentId) : before.evidence.attachments,
  };
  return writeEvidence(db, organisationId, before, evidence, "task.evidence_removed", v);
}

export const TickChecklistItemInput = z.object({
  taskId: z.string().uuid(),
  index: z.number().int().min(0).max(49),
  done: z.boolean(),
  ...ActorFields,
});
export type TickChecklistItemInput = z.input<typeof TickChecklistItemInput>;

/** Ticks (or unticks) one proof item, recording who and when. */
export async function tickChecklistItem(db: Db, organisationId: string, input: TickChecklistItemInput): Promise<TaskRow> {
  const v = TickChecklistItemInput.parse(input);
  const before = await loadTask(db, organisationId, v.taskId);
  if (v.index >= before.evidence.checklist.length) throw new Error(`evidence checklist index ${v.index} is out of range`);
  const now = new Date().toISOString();
  const checklist = before.evidence.checklist.map((entry, i) => {
    if (i !== v.index) return entry;
    return v.done
      ? { item: entry.item, done: true, ...(v.actorId ? { doneBy: v.actorId } : {}), doneAt: now }
      : { item: entry.item, done: false };
  });
  return writeEvidence(db, organisationId, before, { ...before.evidence, checklist }, "task.evidence_ticked", v);
}
