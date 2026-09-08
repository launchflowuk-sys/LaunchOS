import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

/** Projects still being delivered. Planned counts: it is work that is coming. */
const IN_FLIGHT = ["planned", "active", "on_hold"] as const;

export interface PipelineRow {
  readonly projectId: string;
  readonly name: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly status: string;
  /** The phase being worked now — the first that is not done. Null once every phase is. */
  readonly stage: string | null;
  readonly stageKey: string | null;
  /** 0–100, from phases done over phases total. Null when a project has no phases yet. */
  readonly progress: number | null;
  readonly targetDate: string | null;
}

/**
 * What is being built right now, for the dashboard's delivery pipeline.
 *
 * Progress is counted from phases rather than stored on the project, because a
 * stored percentage is a number somebody has to remember to update and it is
 * wrong the moment they forget. Phases are moved as the work moves, so counting
 * them is the one figure that cannot drift from reality.
 *
 * The current stage is the first phase that is not done, by the sort order the
 * phases were created in — not the first *active* one, because a project
 * between phases has none active and would otherwise show nothing at all.
 */
export async function deliveryPipeline(db: Db, organisationId: string, limit = 6): Promise<PipelineRow[]> {
  const totals = db
    .select({
      projectId: schema.projectPhases.projectId,
      total: sql<number>`count(*)::int`.as("phase_total"),
      done: sql<number>`count(*) filter (where ${schema.projectPhases.status} = 'done')::int`.as("phase_done"),
    })
    .from(schema.projectPhases)
    .where(eq(schema.projectPhases.organisationId, organisationId))
    .groupBy(schema.projectPhases.projectId)
    .as("phase_totals");

  // The first unfinished phase per project, chosen by the phases' own sort.
  // `distinct on` is the one place Postgres beats a window function for
  // brevity, and the order below is what makes it deterministic.
  const current = db
    .select({
      projectId: schema.projectPhases.projectId,
      name: sql<string>`${schema.projectPhases.name}`.as("stage_name"),
      key: sql<string>`${schema.projectPhases.key}`.as("stage_key"),
    })
    .from(schema.projectPhases)
    .where(
      and(
        eq(schema.projectPhases.organisationId, organisationId),
        inArray(schema.projectPhases.status, ["pending", "active"]),
      ),
    )
    .orderBy(schema.projectPhases.projectId, asc(schema.projectPhases.sort))
    .as("current_phase");

  const rows = await db
    .selectDistinctOn([schema.projects.id], {
      projectId: schema.projects.id,
      name: schema.projects.name,
      clientId: schema.projects.clientId,
      clientName: schema.clients.name,
      status: schema.projects.status,
      targetDate: schema.projects.targetDate,
      stage: current.name,
      stageKey: current.key,
      total: totals.total,
      done: totals.done,
    })
    .from(schema.projects)
    .innerJoin(schema.clients, eq(schema.projects.clientId, schema.clients.id))
    .leftJoin(totals, eq(totals.projectId, schema.projects.id))
    .leftJoin(current, eq(current.projectId, schema.projects.id))
    .where(and(eq(schema.projects.organisationId, organisationId), inArray(schema.projects.status, [...IN_FLIGHT])))
    .orderBy(schema.projects.id, desc(schema.projects.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    projectId: row.projectId,
    name: row.name,
    clientId: row.clientId,
    clientName: row.clientName,
    status: row.status,
    stage: row.stage ?? null,
    stageKey: row.stageKey ?? null,
    // Null rather than 0 when a project has no phases: "no plan yet" and "no
    // progress yet" are different things and a bar at zero says the wrong one.
    progress: row.total ? Math.round(((row.done ?? 0) / row.total) * 100) : null,
    targetDate: row.targetDate,
  }));
}
