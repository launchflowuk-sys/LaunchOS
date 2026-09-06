import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { getCaseStudyForProject } from "../case-studies/shared.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { ActorKindSchema, PROJECT_TARGET_TYPE, ProjectRefused, requireProject, type ProjectRow } from "./shared.js";

/**
 * Handing the work over.
 *
 * This is the sign-off `projectProgress` waits for: nothing else can put a
 * client's page at 100%, and no arithmetic can do it without a person. It is
 * therefore the one project write that is deliberately hard to do by accident
 * — once, refused the second time, with the date stamped in the update itself.
 */

export const PROJECT_DELIVERED_NOTIFICATION_KIND = "project.delivered";

export const DeliverProjectInput = z.object({
  projectId: z.string().uuid(),
  deliveredAt: z.date().optional(),
  /** A line for the timeline: what was handed over, and to whom. */
  note: z.string().trim().max(2000).optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type DeliverProjectInput = z.input<typeof DeliverProjectInput>;

export interface DeliverProjectResult {
  project: ProjectRow;
  /** The draft story now waiting to be written, if the project has one. */
  caseStudyId: string | null;
}

/**
 * Marks a project delivered.
 *
 * Outstanding phases and milestones are left exactly as they are. Sweeping
 * them to `done` would make the record say work happened that did not, and the
 * honest version — "delivered, with two care milestones still open" — is what
 * the timeline and the Ops Brief want to be able to say. `projectProgress`
 * already reads delivery as 100%, so nothing needs tidying to make the bar
 * right.
 *
 * The linked case study is moved to `live` but **not** published: delivery is
 * when the story becomes writable, not when it becomes public. The Case Study
 * Writer drafts it and `case_study_publish` is Shoji's decision.
 */
export async function deliverProject(db: Db, organisationId: string, input: DeliverProjectInput): Promise<DeliverProjectResult> {
  const v = DeliverProjectInput.parse(input);
  const before = await requireProject(db, organisationId, v.projectId);
  if (before.deliveredAt) {
    throw new ProjectRefused("already_delivered", `${before.name} was already delivered.`);
  }
  if (before.status === "cancelled") {
    throw new ProjectRefused("not_open", `${before.name} was cancelled — reopen it before delivering it.`);
  }
  const now = v.deliveredAt ?? new Date();
  const study = await getCaseStudyForProject(db, organisationId, before.id);

  const delivered = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // `deliveredAt IS NULL` in the update is the guarantee, not the read
    // above: two people clicking Deliver on the same project must produce one
    // delivery date, one timeline entry and one email.
    const [after] = await tx.update(schema.projects)
      .set({ status: "delivered", deliveredAt: now, updatedAt: new Date() })
      .where(and(
        eq(schema.projects.id, before.id),
        eq(schema.projects.organisationId, organisationId),
        isNull(schema.projects.deliveredAt),
      ))
      .returning();
    if (!after) return null;

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.delivered",
      targetType: PROJECT_TARGET_TYPE, targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: before.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.delivered",
      title: `${before.name} delivered`,
      ...(v.note ? { body: v.note } : {}),
      link: `/projects/${before.id}`,
    });
    if (study) {
      await tx.update(schema.caseStudies)
        .set({ deliveryStatus: "live", updatedAt: new Date() })
        .where(and(eq(schema.caseStudies.id, study.id), eq(schema.caseStudies.organisationId, organisationId)));
    }
    return after;
  });

  if (!delivered) {
    const current = await requireProject(db, organisationId, v.projectId);
    return { project: current, caseStudyId: study?.id ?? null };
  }

  await notifyOwner(db, organisationId, {
    kind: PROJECT_DELIVERED_NOTIFICATION_KIND,
    title: `${delivered.name} delivered`,
    body: study ? "The case study is ready to be written." : "No case study is attached to this project.",
    link: `/projects/${delivered.id}`,
  });
  await emit({ name: "project.delivered", organisationId, projectId: delivered.id });
  return { project: delivered, caseStudyId: study?.id ?? null };
}
