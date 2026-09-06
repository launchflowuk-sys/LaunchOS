import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { listClientReviews } from "./client-review.js";
import { describeProgress, projectProgress, type ProjectProgress } from "./progress.js";
import { listProjectMilestones, listProjectPhases, requireProject } from "./shared.js";

/**
 * A week of a build, in the words a client would use.
 *
 * This is the only thing the Project Reporter is allowed to read, and the
 * shape is the point: everything in it is something the client could see on
 * their own progress page anyway. No money, no invoice, no internal task, no
 * staff name, no vendor. An internal milestone ("Stripe keys rotated") is
 * filtered on `clientVisible` here rather than in the prompt, and a task is
 * counted rather than named unless it is client-visible, because the titles
 * Shoji writes for himself are not written for a client to read.
 *
 * It reads the rows, not the audit log. `phases.done_at`, `milestones.
 * reached_at` and `tasks.completed_at` already say when each thing happened,
 * and scraping `audit_log` for the same facts would mean the update could
 * report a change that was later corrected as though it had stood.
 */

/** Seven days, the window the Friday cron asks for. */
export const PROJECT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How many of anything one week's summary carries. A wall of items is not an update. */
const MAX_ITEMS = 20;

export interface ProjectWeekPhase {
  key: string;
  name: string;
  status: string;
  /** True when it finished inside the window — the "we finished design" line. */
  finishedThisWeek: boolean;
  /** True when it started inside the window — the "we've started building" line. */
  startedThisWeek: boolean;
}

export interface ProjectWeekMilestone {
  title: string;
  detail: string | null;
  reachedAt: string | null;
  targetDate: string | null;
}

export interface ProjectWeekActivity {
  projectId: string;
  name: string;
  summary: string | null;
  status: string;
  targetDate: string | null;
  clientName: string;
  window: { from: string; to: string };
  progress: ProjectProgress;
  /** The sentence under the bar. The update should say the same thing in words. */
  progressSentence: string;
  phases: ProjectWeekPhase[];
  /** Reached inside the window — the news. */
  milestonesReached: ProjectWeekMilestone[];
  /** Client-visible, not yet reached, in order — what is coming next. */
  milestonesNext: ProjectWeekMilestone[];
  tasks: { completedThisWeek: number; openedThisWeek: number; openNow: number };
  /** Client-visible task titles finished this week, for the concrete detail. */
  completedTaskTitles: string[];
  /** Open reviews the client has not answered — an invitation to mention, never to chase. */
  openReviews: { about: string; askedAt: string }[];
}

export const ProjectWeekActivityInput = z.object({
  projectId: z.string().uuid(),
  /** The end of the window; defaults to now. The start is seven days before it. */
  now: z.date().optional(),
  windowMs: z.number().int().min(60_000).optional(),
});
export type ProjectWeekActivityInput = z.input<typeof ProjectWeekActivityInput>;

export async function projectWeekActivity(
  db: Db,
  organisationId: string,
  input: ProjectWeekActivityInput,
): Promise<ProjectWeekActivity> {
  const v = ProjectWeekActivityInput.parse(input);
  const to = v.now ?? new Date();
  const from = new Date(to.getTime() - (v.windowMs ?? PROJECT_WEEK_MS));
  const project = await requireProject(db, organisationId, v.projectId);

  const [client] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, project.clientId), eq(schema.clients.organisationId, organisationId)));

  const [phases, milestones, taskRows, reviews] = await Promise.all([
    listProjectPhases(db, organisationId, project.id),
    listProjectMilestones(db, organisationId, project.id),
    db
      .select({
        title: schema.tasks.title,
        status: schema.tasks.status,
        clientVisible: schema.tasks.clientVisible,
        createdAt: schema.tasks.createdAt,
        completedAt: schema.tasks.completedAt,
      })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.organisationId, organisationId),
        eq(schema.tasks.projectId, project.id),
        isNull(schema.tasks.deletedAt),
      ))
      .orderBy(desc(schema.tasks.completedAt), asc(schema.tasks.createdAt)),
    listClientReviews(db, organisationId, { projectId: project.id, status: "pending", limit: MAX_ITEMS }),
  ]);

  const inWindow = (at: Date | null): boolean => at !== null && at >= from && at < to;
  const clientVisible = milestones.filter((milestone) => milestone.clientVisible);

  const progress = projectProgress({
    status: project.status,
    deliveredAt: project.deliveredAt,
    phases,
    milestones,
  });

  return {
    projectId: project.id,
    name: project.name,
    summary: project.summary,
    status: project.status,
    targetDate: project.targetDate,
    clientName: client?.name ?? "the client",
    window: { from: from.toISOString(), to: to.toISOString() },
    progress,
    progressSentence: describeProgress(progress),
    phases: phases.map((phase) => ({
      key: phase.key,
      name: phase.name,
      status: phase.status,
      finishedThisWeek: phase.status === "done" && inWindow(phase.doneAt),
      startedThisWeek: inWindow(phase.startedAt),
    })),
    milestonesReached: clientVisible
      .filter((milestone) => inWindow(milestone.reachedAt))
      .slice(0, MAX_ITEMS)
      .map(toWeekMilestone),
    milestonesNext: clientVisible
      .filter((milestone) => milestone.reachedAt === null)
      .slice(0, MAX_ITEMS)
      .map(toWeekMilestone),
    tasks: {
      completedThisWeek: taskRows.filter((task) => inWindow(task.completedAt)).length,
      openedThisWeek: taskRows.filter((task) => inWindow(task.createdAt)).length,
      openNow: taskRows.filter((task) => task.status !== "done" && task.status !== "cancelled").length,
    },
    completedTaskTitles: taskRows
      .filter((task) => task.clientVisible && inWindow(task.completedAt))
      .slice(0, MAX_ITEMS)
      .map((task) => task.title),
    openReviews: reviews.flatMap((review) => {
      const about = review.payload["milestoneTitle"] ?? review.payload["projectName"];
      return typeof about === "string" ? [{ about, askedAt: review.createdAt.toISOString() }] : [];
    }),
  };
}

function toWeekMilestone(milestone: typeof schema.projectMilestones.$inferSelect): ProjectWeekMilestone {
  return {
    title: milestone.title,
    detail: milestone.detail,
    reachedAt: milestone.reachedAt?.toISOString() ?? null,
    targetDate: milestone.targetDate,
  };
}

export interface ProjectDueAnUpdate {
  projectId: string;
  clientId: string;
  name: string;
}

/**
 * The projects the Friday fan-out writes an update for.
 *
 * `active` only, not every open project: a `planned` build has nothing to
 * report yet and an `on_hold` one is waiting on the client or on a decision,
 * where a cheerful weekly note reads as tone-deaf. Both are visible on the
 * admin list; neither wants an agent run every week.
 *
 * A project whose last drafted update is still waiting for Shoji is skipped —
 * `approvals_pending_project_update` would refuse the second card anyway, and
 * a run that ends in a refusal is an Opus-priced way of learning nothing.
 */
export async function projectsDueAnUpdate(
  db: Db,
  organisationId: string,
  options: { limit?: number } = {},
): Promise<ProjectDueAnUpdate[]> {
  const rows = await db
    .select({ projectId: schema.projects.id, clientId: schema.projects.clientId, name: schema.projects.name })
    .from(schema.projects)
    .where(and(
      eq(schema.projects.organisationId, organisationId),
      eq(schema.projects.status, "active"),
      isNull(schema.projects.deletedAt),
    ))
    .orderBy(asc(schema.projects.createdAt), asc(schema.projects.id))
    .limit(options.limit ?? 100);
  if (rows.length === 0) return [];

  const waiting = await db
    .select({ projectId: sql<string>`${schema.approvals.payload}->>'projectId'` })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = 'project_update'`,
      inArray(sql`${schema.approvals.payload}->>'projectId'`, rows.map((row) => row.projectId)),
    ));
  const pending = new Set(waiting.map((row) => row.projectId));
  return rows.filter((row) => !pending.has(row.projectId));
}
