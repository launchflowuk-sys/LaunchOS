import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { listProjectMilestones, listProjectPhases } from "../projects/shared.js";
import { requireCaseStudy } from "./shared.js";

/**
 * Everything the Case Study Writer is allowed to know, and nothing else.
 *
 * This is the read half of the allow-list; `case-study-save-draft.ts` in
 * `packages/agents` is the write half. Both are structural rather than
 * instructional, because a prompt is not a boundary: a model that is *told*
 * not to mention the price is one confused turn away from mentioning it, while
 * a model that is never given the price cannot.
 *
 * So this function selects columns rather than rows. It reads a fixed list of
 * fields off `case_studies` and `projects`, and it does not read `proposals`,
 * `invoices`, `subscriptions`, `packages`, `client_access_entries`,
 * `secrets`, `tasks`, `notifications` or `audit_log` at all — there is no code
 * path from here to any of them. The client's *name* is included because the
 * story is about them and their name is on the public page already; the client
 * *record* is not, so nothing on it (their email, their plan, their internal
 * notes) can arrive by accident when somebody later adds a column to it.
 *
 * Milestones are filtered on `clientVisible`. An internal checkpoint is a
 * sentence Shoji wrote for Shoji, and half of them name a provider or a
 * credential rotation. Phases carry their name and status only — never their
 * dates, which would let a story say how long a client took to answer.
 */

/** The fields on `case_studies` the writer may see. Anything not here is not read. */
export const CASE_STUDY_MATERIAL_FIELDS = [
  "slug", "name", "clientName", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "kind", "deliveryStatus",
] as const;

export interface CaseStudyMaterialPhase {
  name: string;
  status: string;
}

export interface CaseStudyMaterialMilestone {
  title: string;
  detail: string | null;
  reached: boolean;
}

export interface CaseStudyMaterial {
  caseStudyId: string;
  slug: string;
  name: string;
  /** Who it was for, as the public page already says it. */
  clientName: string | null;
  sector: string;
  summary: string;
  brief: { client: string; problem: string; built: string; results: string };
  stack: string[];
  year: number | null;
  /** The live public address, or null when there is not one yet. */
  url: string | null;
  screenshots: { desktop?: string; mobile?: string };
  kind: string;
  deliveryStatus: string;
  status: string;
  /** The spine, names and states only. */
  phases: CaseStudyMaterialPhase[];
  /** Client-visible milestones only — the promises the client themselves saw. */
  milestones: CaseStudyMaterialMilestone[];
  /** The day it went live, ISO. Null on a story with no project or no sign-off. */
  deliveredAt: string | null;
  projectName: string | null;
}

export const CaseStudyMaterialInput = z.object({ caseStudyId: z.string().uuid() });
export type CaseStudyMaterialInput = z.input<typeof CaseStudyMaterialInput>;

export async function caseStudyMaterial(
  db: Db,
  organisationId: string,
  input: CaseStudyMaterialInput,
): Promise<CaseStudyMaterial> {
  const v = CaseStudyMaterialInput.parse(input);
  const study = await requireCaseStudy(db, organisationId, v.caseStudyId);

  // Named columns, not `select()`: a column added to `projects` next year must
  // not silently become something the model can read.
  const [project] = study.projectId
    ? await db
        .select({
          id: schema.projects.id,
          name: schema.projects.name,
          deliveredAt: schema.projects.deliveredAt,
        })
        .from(schema.projects)
        .where(and(
          eq(schema.projects.id, study.projectId),
          eq(schema.projects.organisationId, organisationId),
          isNull(schema.projects.deletedAt),
        ))
    : [];

  const [phases, milestones] = project
    ? await Promise.all([
        listProjectPhases(db, organisationId, project.id),
        listProjectMilestones(db, organisationId, project.id),
      ])
    : [[], []];

  return {
    caseStudyId: study.id,
    slug: study.slug,
    name: study.name,
    clientName: study.clientName,
    sector: study.sector,
    summary: study.summary,
    brief: study.brief,
    stack: [...study.stack],
    year: study.year,
    url: study.url,
    screenshots: { ...study.screenshots },
    kind: study.kind,
    deliveryStatus: study.deliveryStatus,
    status: study.status,
    phases: phases.map((phase) => ({ name: phase.name, status: phase.status })),
    milestones: milestones
      .filter((milestone) => milestone.clientVisible)
      .map((milestone) => ({ title: milestone.title, detail: milestone.detail, reached: milestone.reachedAt !== null })),
    deliveredAt: project?.deliveredAt?.toISOString() ?? null,
    projectName: project?.name ?? null,
  };
}
