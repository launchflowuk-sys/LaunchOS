import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ProjectPhaseKey } from "@launchos/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { ensureCaseStudyForProject } from "../case-studies/crud.js";
import { getProposalDetail } from "../proposals/crud.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  ActorKindSchema,
  DateKeySchema,
  PROJECT_TARGET_TYPE,
  ProjectRefused,
  STANDARD_PHASES,
  getProjectForProposal,
  requireProject,
  type ProjectRow,
} from "./shared.js";

/**
 * Starting a build, and keeping its headline facts right.
 *
 * The spine and the milestones are written here in the same transaction as the
 * project, because a project with no phases is not a lighter version of a
 * project — it is a progress page that says 0% and cannot say anything else.
 */

/**
 * How many of an accepted proposal's deliverables become milestones.
 *
 * A proposal with forty deliverables is a project plan, and turning all forty
 * into milestones makes a client's page a wall rather than a story. The cap
 * matches `MAX_PROJECT_TASKS` in the worker for the same reason.
 */
export const MAX_PROPOSAL_MILESTONES = 20;

/** Where a deliverable lands on the spine. It is a thing we build. */
const DELIVERABLE_PHASE: ProjectPhaseKey = "build";

export const ProjectPhaseInput = z.object({
  key: z.enum(schema.projectPhaseKeyEnum.enumValues),
  name: z.string().trim().min(1).max(120).optional(),
  sort: z.number().int().min(0).max(999).optional(),
});
export type ProjectPhaseInput = z.input<typeof ProjectPhaseInput>;

export const ProjectMilestoneInput = z.object({
  title: z.string().trim().min(1, "a milestone needs a title").max(300),
  detail: z.string().trim().max(4000).optional(),
  /** Which step of the spine it sits under. Unmatched keys leave it unattached. */
  phaseKey: z.enum(schema.projectPhaseKeyEnum.enumValues).optional(),
  targetDate: DateKeySchema.optional(),
  sort: z.number().int().min(0).max(999).optional(),
  clientVisible: z.boolean().default(true),
});
export type ProjectMilestoneInput = z.input<typeof ProjectMilestoneInput>;

export const CreateProjectInput = z.object({
  clientId: z.string().uuid().optional(),
  /** An accepted proposal to build from. Fills the name, summary and milestones. */
  proposalId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().max(4000).optional(),
  status: z.enum(schema.projectStatusEnum.enumValues).default("planned"),
  targetDate: DateKeySchema.optional(),
  startedAt: z.date().optional(),
  phases: z.array(ProjectPhaseInput).max(20).optional(),
  milestones: z.array(ProjectMilestoneInput).max(200).optional(),
  /** Start the draft story with it. Off only where a caller has its own. */
  caseStudy: z.boolean().default(true),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type CreateProjectInput = z.input<typeof CreateProjectInput>;

export interface CreateProjectResult {
  project: ProjectRow;
  phases: (typeof schema.projectPhases.$inferSelect)[];
  milestones: (typeof schema.projectMilestones.$inferSelect)[];
  /** The draft case study the project starts with, unless the caller declined one. */
  caseStudyId: string | null;
}

/** What a proposal contributes: the name, the summary and one milestone per deliverable. */
interface ProposalSeed {
  clientId: string;
  name: string;
  summary: string | null;
  milestones: ProjectMilestoneInput[];
}

/**
 * Reads an accepted proposal into the shape `createProject` takes.
 *
 * Split out so the worker job that runs on acceptance can look at what it is
 * about to create — and so the mapping from "what we sold" to "what we
 * promised to build" is one readable function rather than a branch buried in
 * the middle of a transaction.
 */
async function seedFromProposal(db: Db, organisationId: string, proposalId: string): Promise<ProposalSeed> {
  const detail = await getProposalDetail(db, organisationId, proposalId);
  if (!detail) throw new ProjectRefused("not_found", "That proposal could not be found.");
  if (!detail.proposal.clientId) {
    throw new ProjectRefused(
      "not_found",
      `Proposal ${detail.proposal.reference} has no client yet — accept it first, or say which client this project is for.`,
    );
  }
  const existing = await getProjectForProposal(db, organisationId, proposalId);
  if (existing) {
    throw new ProjectRefused("already_exists", `Proposal ${detail.proposal.reference} already has a project.`);
  }
  return {
    clientId: detail.proposal.clientId,
    name: detail.proposal.title,
    summary: detail.proposal.summary,
    milestones: detail.proposal.scope.deliverables.slice(0, MAX_PROPOSAL_MILESTONES).map((deliverable, index) => ({
      title: deliverable,
      phaseKey: DELIVERABLE_PHASE,
      sort: index,
      clientVisible: true,
    })),
  };
}

/**
 * Creates a project, its spine and its milestones in one transaction.
 *
 * A proposal is optional and, when given, supplies the parts nobody should
 * retype: the client, the title, the summary and one milestone per deliverable
 * the client actually agreed to. Anything passed explicitly wins over it, so
 * the same call serves the worker (proposal only) and the admin form (fields
 * only) without a second function.
 *
 * A proposal that already has a project is refused rather than duplicated —
 * `projects_proposal` is unique, and the worker's retry should call
 * `getProjectForProposal` first and treat a hit as done.
 */
export async function createProject(db: Db, organisationId: string, input: CreateProjectInput): Promise<CreateProjectResult> {
  const v = CreateProjectInput.parse(input);
  const seed = v.proposalId ? await seedFromProposal(db, organisationId, v.proposalId) : null;
  const clientId = v.clientId ?? seed?.clientId;
  if (!clientId) throw new ProjectRefused("not_found", "A project needs a client to be for.");
  await assertOwned(db, organisationId, schema.clients, clientId);

  const name = v.name ?? seed?.name;
  if (!name) throw new ProjectRefused("not_found", "A project needs a name.");
  const summary = v.summary ?? seed?.summary ?? null;
  const milestones = v.milestones ?? seed?.milestones ?? [];
  const phases: ProjectPhaseInput[] = v.phases ?? STANDARD_PHASES.map((phase) => ({ key: phase.key, name: phase.name }));
  const now = v.now ?? new Date();
  const startedAt = v.startedAt ?? (v.status === "active" ? now : null);

  const created = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [project] = await tx.insert(schema.projects).values({
      organisationId,
      clientId,
      proposalId: v.proposalId ?? null,
      name,
      summary,
      status: v.status,
      startedAt,
      targetDate: v.targetDate ?? null,
      deliveredAt: null,
    }).returning();

    const phaseRows = phases.length === 0 ? [] : await tx.insert(schema.projectPhases).values(
      phases.map((phase, index) => ({
        organisationId,
        projectId: project!.id,
        clientId,
        key: phase.key,
        name: phase.name ?? STANDARD_PHASES.find((standard) => standard.key === phase.key)?.name ?? phase.key,
        sort: phase.sort ?? index,
      })),
    ).returning();

    const byKey = new Map(phaseRows.map((phase) => [phase.key, phase.id]));
    const milestoneRows = milestones.length === 0 ? [] : await tx.insert(schema.projectMilestones).values(
      milestones.map((milestone, index) => {
        const parsed = ProjectMilestoneInput.parse(milestone);
        return {
          organisationId,
          projectId: project!.id,
          clientId,
          phaseId: parsed.phaseKey ? (byKey.get(parsed.phaseKey) ?? null) : null,
          title: parsed.title,
          detail: parsed.detail ?? null,
          targetDate: parsed.targetDate ?? null,
          sort: parsed.sort ?? index,
          clientVisible: parsed.clientVisible,
        };
      }),
    ).returning();

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.created",
      targetType: PROJECT_TARGET_TYPE, targetId: project!.id, after: project,
    });
    await recordActivity(tx, organisationId, {
      clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.created",
      title: `Project started: ${name}`,
      ...(summary ? { body: summary } : {}),
      link: `/projects/${project!.id}`,
    });

    return { project: project!, phases: phaseRows, milestones: milestoneRows };
  });

  // Outside the transaction on purpose: a draft story nobody can see is worth
  // less than the project it describes, and a failure here must not roll back
  // a build that has already been started.
  let caseStudyId: string | null = null;
  if (v.caseStudy) {
    const study = await ensureCaseStudyForProject(db, organisationId, {
      projectId: created.project.id,
      clientId,
      name,
      ...(summary ? { summary } : {}),
      actorKind: v.actorKind,
      ...(v.actorId ? { actorId: v.actorId } : {}),
      now,
    });
    caseStudyId = study.id;
  }

  return { ...created, caseStudyId };
}

export const UpdateProjectInput = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().max(4000).nullish(),
  status: z.enum(schema.projectStatusEnum.enumValues).optional(),
  targetDate: DateKeySchema.nullish(),
  startedAt: z.date().nullish(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type UpdateProjectInput = z.input<typeof UpdateProjectInput>;

/**
 * Amends the headline facts.
 *
 * `delivered_at` is not in the input: delivery is a sign-off with a client
 * email and a case study behind it, and `deliverProject` is where that lives.
 * Moving a project to `active` stamps `started_at` if nothing has yet, so the
 * first real day is recorded without anybody having to remember to type it.
 */
export async function updateProject(db: Db, organisationId: string, input: UpdateProjectInput): Promise<ProjectRow> {
  const v = UpdateProjectInput.parse(input);
  const before = await requireProject(db, organisationId, v.projectId);
  const now = v.now ?? new Date();
  const starting = v.status === "active" && before.startedAt === null && v.startedAt === undefined;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.projects)
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.summary !== undefined ? { summary: v.summary ?? null } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.targetDate !== undefined ? { targetDate: v.targetDate ?? null } : {}),
        ...(v.startedAt !== undefined ? { startedAt: v.startedAt ?? null } : {}),
        ...(starting ? { startedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.projects.id, before.id), eq(schema.projects.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "project.updated",
      targetType: PROJECT_TARGET_TYPE, targetId: before.id, before, after,
    });
    return after!;
  });
}

export const ListProjectsInput = z.object({
  status: z.enum(schema.projectStatusEnum.enumValues).optional(),
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListProjectsInput = z.input<typeof ListProjectsInput>;

/** Newest first — the admin list, and the strip on a client page. */
export async function listProjects(db: Db, organisationId: string, input: ListProjectsInput = {}): Promise<ProjectRow[]> {
  const v = ListProjectsInput.parse(input);
  return db.select().from(schema.projects)
    .where(and(
      eq(schema.projects.organisationId, organisationId),
      isNull(schema.projects.deletedAt),
      v.status ? eq(schema.projects.status, v.status) : undefined,
      v.clientId ? eq(schema.projects.clientId, v.clientId) : undefined,
    ))
    .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id))
    .limit(v.limit);
}
