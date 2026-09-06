import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ProjectPhaseKey } from "@launchos/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

/**
 * What every module in this folder shares: the row types, the refusal, the six
 * standard phases, and the reads that take an id.
 */

export { PROJECT_CLOSED_STATUSES, PROJECT_OPEN_STATUSES, PROJECT_PHASE_KEYS } from "@launchos/db/schema";

export type ProjectRow = typeof schema.projects.$inferSelect;
export type ProjectPhaseRow = typeof schema.projectPhases.$inferSelect;
export type ProjectMilestoneRow = typeof schema.projectMilestones.$inferSelect;

export const ActorKindSchema = z.enum(["user", "client", "agent", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/**
 * Where a client reads their own progress page.
 *
 * Named here rather than typed as a literal wherever a link is built, because
 * three things have to agree on it — the branded email's button, the portal
 * route itself and the Ops Brief — and a route that moves should break the
 * build rather than a client's link.
 */
export const PROJECT_PORTAL_PATH = "/portal/projects";

/** The audit target types the three tables are recorded under. */
export const PROJECT_TARGET_TYPE = "project";
export const PHASE_TARGET_TYPE = "project_phase";
export const MILESTONE_TARGET_TYPE = "project_milestone";

/** Everything a project can refuse to do, and the message the caller shows. */
export class ProjectRefused extends Error {
  constructor(
    readonly reason: "not_found" | "not_open" | "already_delivered" | "wrong_project" | "already_exists",
    message: string,
  ) {
    super(message);
    this.name = "ProjectRefused";
  }
}

export const DateKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "a date must be YYYY-MM-DD");

/**
 * The spine every project starts with, in order.
 *
 * Seeded rather than implied so a phase can be renamed, skipped or dated on
 * one project without every other project changing shape. `care` is included
 * from the start because a client on a monthly plan is buying it, and a plan
 * that ends at "launch" is how aftercare gets forgotten.
 */
export const STANDARD_PHASES: readonly { key: ProjectPhaseKey; name: string }[] = [
  { key: "brief", name: "Brief" },
  { key: "design", name: "Design" },
  { key: "build", name: "Build" },
  { key: "review", name: "Review" },
  { key: "launch", name: "Launch" },
  { key: "care", name: "Care" },
];

/** One project in this organisation. Null when it is another tenant's, or gone. */
export async function getProjectRow(db: Db, organisationId: string, projectId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(
      eq(schema.projects.id, projectId),
      eq(schema.projects.organisationId, organisationId),
      isNull(schema.projects.deletedAt),
    ));
  return row ?? null;
}

/** The same, or a `ProjectRefused("not_found")`. */
export async function requireProject(db: Db, organisationId: string, projectId: string): Promise<ProjectRow> {
  const project = await getProjectRow(db, organisationId, projectId);
  if (!project) throw new ProjectRefused("not_found", "That project could not be found.");
  return project;
}

/** The project an accepted proposal already produced, if it produced one. */
export async function getProjectForProposal(db: Db, organisationId: string, proposalId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(
      eq(schema.projects.organisationId, organisationId),
      eq(schema.projects.proposalId, proposalId),
      isNull(schema.projects.deletedAt),
    ));
  return row ?? null;
}

/** The spine, in the order it is drawn. */
export async function listProjectPhases(db: Db, organisationId: string, projectId: string): Promise<ProjectPhaseRow[]> {
  return db
    .select()
    .from(schema.projectPhases)
    .where(and(
      eq(schema.projectPhases.projectId, projectId),
      eq(schema.projectPhases.organisationId, organisationId),
      isNull(schema.projectPhases.deletedAt),
    ))
    .orderBy(asc(schema.projectPhases.sort), asc(schema.projectPhases.createdAt), asc(schema.projectPhases.id));
}

/** Every milestone on the project, internal ones included. The portal filters. */
export async function listProjectMilestones(db: Db, organisationId: string, projectId: string): Promise<ProjectMilestoneRow[]> {
  return db
    .select()
    .from(schema.projectMilestones)
    .where(and(
      eq(schema.projectMilestones.projectId, projectId),
      eq(schema.projectMilestones.organisationId, organisationId),
      isNull(schema.projectMilestones.deletedAt),
    ))
    .orderBy(asc(schema.projectMilestones.sort), asc(schema.projectMilestones.createdAt), asc(schema.projectMilestones.id));
}

/** One phase, checked to be on the project the caller thinks it is. */
export async function requirePhaseOfProject(
  db: Db,
  organisationId: string,
  projectId: string,
  phaseId: string,
): Promise<ProjectPhaseRow> {
  const [row] = await db
    .select()
    .from(schema.projectPhases)
    .where(and(
      eq(schema.projectPhases.id, phaseId),
      eq(schema.projectPhases.projectId, projectId),
      eq(schema.projectPhases.organisationId, organisationId),
      isNull(schema.projectPhases.deletedAt),
    ));
  if (!row) throw new ProjectRefused("wrong_project", "That step is not part of this project.");
  return row;
}

/** One milestone, checked the same way. */
export async function requireMilestoneOfProject(
  db: Db,
  organisationId: string,
  projectId: string,
  milestoneId: string,
): Promise<ProjectMilestoneRow> {
  const [row] = await db
    .select()
    .from(schema.projectMilestones)
    .where(and(
      eq(schema.projectMilestones.id, milestoneId),
      eq(schema.projectMilestones.projectId, projectId),
      eq(schema.projectMilestones.organisationId, organisationId),
      isNull(schema.projectMilestones.deletedAt),
    ));
  if (!row) throw new ProjectRefused("wrong_project", "That milestone is not part of this project.");
  return row;
}
