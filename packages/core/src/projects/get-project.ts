import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { TaskStatus } from "@launchos/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { projectProgress, type ProjectProgress } from "./progress.js";
import {
  getProjectRow,
  listProjectMilestones,
  listProjectPhases,
  type ProjectMilestoneRow,
  type ProjectPhaseRow,
  type ProjectRow,
} from "./shared.js";

/**
 * Everything one project screen needs, read the same way whether it is the
 * admin page or the client's.
 *
 * **This must not be N+1.** The client's progress page is the one that gets
 * opened on a phone on mobile data, and the shape that invites the mistake is
 * obvious: draw the six phases, then for each one fetch its milestones and
 * count its tasks. That is thirteen round trips on a page that needs four, and
 * it gets worse every time a project grows a phase.
 *
 * So the milestones come back in one ordered read and the task counts in one
 * grouped read, both keyed by phase id in memory. There is no query inside a
 * loop here and there must never be one: a page that wants something per phase
 * takes it from `tasksByPhase`, it does not go back to the database.
 *
 * The project itself is read first because it is also the tenancy check — a
 * project in another organisation is `null` before any of the rest is asked
 * for — and the three collection reads then run together, so the whole screen
 * is two round trips regardless of how big the project is.
 */

/** Tasks under one phase, or under the project with no phase set. */
export interface PhaseTaskCounts {
  total: number;
  done: number;
  open: number;
}

const EMPTY_COUNTS: PhaseTaskCounts = { total: 0, done: 0, open: 0 };

/** The key `tasksByPhase` files a task with no phase under. */
export const UNPHASED = "unphased";

export interface ProjectDetail {
  project: ProjectRow;
  phases: ProjectPhaseRow[];
  /** Every milestone, internal ones included. The portal filters on `clientVisible`. */
  milestones: ProjectMilestoneRow[];
  /** Across the whole project. */
  tasks: PhaseTaskCounts;
  /** By `project_phases.id`, plus `UNPHASED`. Read it; do not re-query. */
  tasksByPhase: Record<string, PhaseTaskCounts>;
  progress: ProjectProgress;
}

/**
 * A cancelled task is neither done nor outstanding — it was called off — so it
 * is left out of every total rather than quietly counted as work still owed.
 */
const DONE_STATUSES: readonly TaskStatus[] = ["done"];
const IGNORED_STATUSES: readonly TaskStatus[] = ["cancelled"];

interface TaskCountRow {
  phaseId: string | null;
  status: TaskStatus;
  n: number;
}

/** One grouped read: how many tasks of each status sit under each phase. */
async function taskCounts(db: Db, organisationId: string, projectId: string): Promise<TaskCountRow[]> {
  return db
    .select({ phaseId: schema.tasks.phaseId, status: schema.tasks.status, n: count() })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      eq(schema.tasks.projectId, projectId),
      isNull(schema.tasks.deletedAt),
    ))
    .groupBy(schema.tasks.phaseId, schema.tasks.status);
}

function tallied(rows: readonly TaskCountRow[]): { total: PhaseTaskCounts; byPhase: Record<string, PhaseTaskCounts> } {
  const byPhase: Record<string, PhaseTaskCounts> = {};
  let total = EMPTY_COUNTS;
  for (const row of rows) {
    if (IGNORED_STATUSES.includes(row.status)) continue;
    const key = row.phaseId ?? UNPHASED;
    const done = DONE_STATUSES.includes(row.status) ? row.n : 0;
    const current = byPhase[key] ?? EMPTY_COUNTS;
    byPhase[key] = { total: current.total + row.n, done: current.done + done, open: current.open + (row.n - done) };
    total = { total: total.total + row.n, done: total.done + done, open: total.open + (row.n - done) };
  }
  return { total, byPhase };
}

export async function getProject(db: Db, organisationId: string, projectId: string): Promise<ProjectDetail | null> {
  const project = await getProjectRow(db, organisationId, projectId);
  if (!project) return null;

  const [phases, milestones, counts] = await Promise.all([
    listProjectPhases(db, organisationId, projectId),
    listProjectMilestones(db, organisationId, projectId),
    taskCounts(db, organisationId, projectId),
  ]);
  const { total, byPhase } = tallied(counts);

  return {
    project,
    phases,
    milestones,
    tasks: total,
    tasksByPhase: byPhase,
    progress: projectProgress({
      status: project.status,
      deliveredAt: project.deliveredAt,
      phases,
      milestones,
    }),
  };
}
