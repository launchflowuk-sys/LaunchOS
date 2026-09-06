import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import {
  ActorKindSchema,
  PHASE_TARGET_TYPE,
  requirePhaseOfProject,
  requireProject,
  type ProjectPhaseRow,
} from "./shared.js";

/**
 * Moving the spine.
 *
 * Phases are deliberately not a state machine: Shoji works on design and build
 * at once, skips review on a one-page site, and occasionally has to put a
 * finished phase back because a client changed their mind. Refusing "done →
 * active" would be tidy and wrong, so any status may follow any other and the
 * timestamps are what carry the history.
 */

export const SetPhaseStatusInput = z.object({
  projectId: z.string().uuid(),
  phaseId: z.string().uuid(),
  status: z.enum(schema.projectPhaseStatusEnum.enumValues),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type SetPhaseStatusInput = z.input<typeof SetPhaseStatusInput>;

/**
 * Sets a phase's status and the two stamps that follow from it.
 *
 * `started_at` is written once and kept: the day work began on a phase does
 * not change because it was reopened. `done_at` is cleared when a phase leaves
 * `done`, because it is the answer to "when was this finished" and a phase
 * that has been reopened has no answer yet — leaving a stale date there would
 * put a wrong day in the Friday update.
 */
export async function setPhaseStatus(db: Db, organisationId: string, input: SetPhaseStatusInput): Promise<ProjectPhaseRow> {
  const v = SetPhaseStatusInput.parse(input);
  const project = await requireProject(db, organisationId, v.projectId);
  const before = await requirePhaseOfProject(db, organisationId, v.projectId, v.phaseId);
  const now = v.now ?? new Date();
  const starting = before.startedAt === null && v.status !== "pending";

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.projectPhases)
      .set({
        status: v.status,
        ...(starting ? { startedAt: now } : {}),
        doneAt: v.status === "done" ? (before.doneAt ?? now) : null,
        updatedAt: now,
      })
      .where(and(eq(schema.projectPhases.id, before.id), eq(schema.projectPhases.organisationId, organisationId)))
      .returning();

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.phase_status_changed",
      targetType: PHASE_TARGET_TYPE, targetId: before.id, before, after,
    });
    // Only a finished phase is news on the client's timeline. "Design is now
    // active" is our bookkeeping; "Design is done" is something they wanted.
    if (v.status === "done" && before.status !== "done") {
      await recordActivity(tx, organisationId, {
        clientId: project.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.phase_done",
        title: `${after!.name} finished on ${project.name}`,
        link: `/projects/${project.id}`,
      });
    }
    return after!;
  });
}
