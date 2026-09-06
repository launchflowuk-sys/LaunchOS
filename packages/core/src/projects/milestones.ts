import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import {
  ActorKindSchema,
  DateKeySchema,
  MILESTONE_TARGET_TYPE,
  ProjectRefused,
  requireMilestoneOfProject,
  requirePhaseOfProject,
  requireProject,
  type ProjectMilestoneRow,
} from "./shared.js";

/**
 * The promises on a project, and the moment one of them is kept.
 *
 * A milestone is the client's vocabulary — "the booking form takes a card" —
 * where a phase is ours. It is the unit `projectProgress` counts alongside the
 * spine, and the only thing on a project that is worth emailing about on the
 * day it happens.
 */

export const AddMilestoneInput = z.object({
  projectId: z.string().uuid(),
  phaseId: z.string().uuid().optional(),
  title: z.string().trim().min(1, "a milestone needs a title").max(300),
  detail: z.string().trim().max(4000).optional(),
  targetDate: DateKeySchema.optional(),
  sort: z.number().int().min(0).max(999).optional(),
  clientVisible: z.boolean().default(true),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type AddMilestoneInput = z.input<typeof AddMilestoneInput>;

/** The next place in the list, so a new milestone lands at the end of it. */
async function nextSort(db: Db, organisationId: string, projectId: string): Promise<number> {
  const rows = await db
    .select({ sort: schema.projectMilestones.sort })
    .from(schema.projectMilestones)
    .where(and(
      eq(schema.projectMilestones.organisationId, organisationId),
      eq(schema.projectMilestones.projectId, projectId),
    ));
  return rows.reduce((highest, row) => Math.max(highest, row.sort), -1) + 1;
}

export async function addMilestone(db: Db, organisationId: string, input: AddMilestoneInput): Promise<ProjectMilestoneRow> {
  const v = AddMilestoneInput.parse(input);
  const project = await requireProject(db, organisationId, v.projectId);
  if (v.phaseId) await requirePhaseOfProject(db, organisationId, v.projectId, v.phaseId);
  const sort = v.sort ?? (await nextSort(db, organisationId, v.projectId));

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.projectMilestones).values({
      organisationId,
      projectId: project.id,
      phaseId: v.phaseId ?? null,
      clientId: project.clientId,
      title: v.title,
      detail: v.detail ?? null,
      targetDate: v.targetDate ?? null,
      sort,
      clientVisible: v.clientVisible,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.milestone_added",
      targetType: MILESTONE_TARGET_TYPE, targetId: row!.id, after: row,
    });
    return row!;
  });
}

export const UpdateMilestoneInput = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  phaseId: z.string().uuid().nullish(),
  title: z.string().trim().min(1).max(300).optional(),
  detail: z.string().trim().max(4000).nullish(),
  targetDate: DateKeySchema.nullish(),
  sort: z.number().int().min(0).max(999).optional(),
  clientVisible: z.boolean().optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type UpdateMilestoneInput = z.input<typeof UpdateMilestoneInput>;

/**
 * Amends a milestone. `reachedAt` is not here on purpose: reaching one is an
 * event with an email behind it, and `reachMilestone` is the only door to it.
 */
export async function updateMilestone(db: Db, organisationId: string, input: UpdateMilestoneInput): Promise<ProjectMilestoneRow> {
  const v = UpdateMilestoneInput.parse(input);
  const before = await requireMilestoneOfProject(db, organisationId, v.projectId, v.milestoneId);
  if (v.phaseId) await requirePhaseOfProject(db, organisationId, v.projectId, v.phaseId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.projectMilestones)
      .set({
        ...(v.phaseId !== undefined ? { phaseId: v.phaseId ?? null } : {}),
        ...(v.title !== undefined ? { title: v.title } : {}),
        ...(v.detail !== undefined ? { detail: v.detail ?? null } : {}),
        ...(v.targetDate !== undefined ? { targetDate: v.targetDate ?? null } : {}),
        ...(v.sort !== undefined ? { sort: v.sort } : {}),
        ...(v.clientVisible !== undefined ? { clientVisible: v.clientVisible } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.projectMilestones.id, before.id),
        eq(schema.projectMilestones.organisationId, organisationId),
      ))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.milestone_updated",
      targetType: MILESTONE_TARGET_TYPE, targetId: before.id, before, after,
    });
    return after!;
  });
}

export const ReachMilestoneInput = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  reachedAt: z.date().optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type ReachMilestoneInput = z.input<typeof ReachMilestoneInput>;

export interface ReachMilestoneResult {
  milestone: ProjectMilestoneRow;
  /** False when it had already been reached — the caller should send nothing. */
  recorded: boolean;
}

/**
 * Marks a promise kept, once.
 *
 * `WHERE reached_at IS NULL` in the update itself is what makes it once: two
 * clicks a moment apart both pass the read, and exactly one gets a row back.
 * Only that one records the timeline entry and emits the event, so the client
 * gets one email rather than two — which matters more here than anywhere else
 * on a project, because this is the one thing that reaches them the same day.
 *
 * The event is emitted after the transaction commits, for the reason every
 * other domain here does it: a job that fires on a write that rolled back is a
 * message about something that did not happen.
 */
export async function reachMilestone(db: Db, organisationId: string, input: ReachMilestoneInput): Promise<ReachMilestoneResult> {
  const v = ReachMilestoneInput.parse(input);
  const project = await requireProject(db, organisationId, v.projectId);
  const before = await requireMilestoneOfProject(db, organisationId, v.projectId, v.milestoneId);
  if (before.reachedAt) return { milestone: before, recorded: false };
  const now = v.reachedAt ?? new Date();

  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.projectMilestones)
      .set({ reachedAt: now, updatedAt: new Date() })
      .where(and(
        eq(schema.projectMilestones.id, before.id),
        eq(schema.projectMilestones.organisationId, organisationId),
        isNull(schema.projectMilestones.reachedAt),
      ))
      .returning();
    if (!after) return null;
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.milestone_reached",
      targetType: MILESTONE_TARGET_TYPE, targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: project.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.milestone_reached",
      title: `Milestone reached on ${project.name}: ${after.title}`,
      ...(after.detail ? { body: after.detail } : {}),
      link: `/projects/${project.id}`,
    });
    return after;
  });

  if (!result) {
    const current = await requireMilestoneOfProject(db, organisationId, v.projectId, v.milestoneId);
    return { milestone: current, recorded: false };
  }
  await emit({ name: "project.milestone_reached", organisationId, projectId: project.id, milestoneId: result.id });
  return { milestone: result, recorded: true };
}

export { ProjectRefused };
