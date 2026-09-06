import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

/**
 * Reading the agent ledger.
 *
 * `agent_runs` and `agent_steps` have recorded every step of every agent since
 * the kernel was written, and until now the only way to open one was a link
 * from something it produced — an ad report, a brief, an incident. A run that
 * produced nothing was invisible, which is exactly the run somebody needs to
 * find: the one that failed, or the one still sitting `awaiting_approval` with
 * nobody told.
 *
 * Read-only, so there is no audit row here. The tenancy rule is the same as
 * everywhere else and is the only thing that could go wrong: `organisationId`
 * is in every `where`, never an argument the caller can forget.
 */

export type AgentRunRow = typeof schema.agentRuns.$inferSelect;

export const AGENT_RUN_STATUSES = ["running", "completed", "awaiting_approval", "failed"] as const;
export const AGENT_RUN_TRIGGERS = ["cron", "event", "manual", "resume"] as const;

export const ListAgentRunsInput = z.object({
  agentKey: z.string().trim().min(1).max(100).optional(),
  status: z.enum(AGENT_RUN_STATUSES).optional(),
  trigger: z.enum(AGENT_RUN_TRIGGERS).optional(),
  /** One page. The ledger grows for ever; the screen shows a window of it. */
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListAgentRunsInput = z.input<typeof ListAgentRunsInput>;

export interface AgentRunSummary extends AgentRunRow {
  /** How many steps it recorded — the cheap signal for "did it actually do anything". */
  steps: number;
  /** Wall clock in milliseconds, or null while it is still running. */
  durationMs: number | null;
}

export interface ListAgentRunsResult {
  runs: AgentRunSummary[];
  /** Every run matching the filters, so the page can say "50 of 312". */
  total: number;
}

/**
 * A page of runs, newest first, with each one's step count.
 *
 * The step count is one grouped read rather than one per row: an agent run
 * list is the screen most likely to be opened when something is already wrong,
 * and an N+1 there would be slowest exactly when it matters.
 */
export async function listAgentRuns(db: Db, organisationId: string, input: ListAgentRunsInput = {}): Promise<ListAgentRunsResult> {
  const v = ListAgentRunsInput.parse(input);
  const where = and(
    eq(schema.agentRuns.organisationId, organisationId),
    ...(v.agentKey ? [eq(schema.agentRuns.agentKey, v.agentKey)] : []),
    ...(v.status ? [eq(schema.agentRuns.status, v.status)] : []),
    ...(v.trigger ? [eq(schema.agentRuns.trigger, v.trigger)] : []),
  );

  const [rows, [totals]] = await Promise.all([
    db.select().from(schema.agentRuns).where(where)
      .orderBy(desc(schema.agentRuns.startedAt), desc(schema.agentRuns.id))
      .limit(v.limit).offset(v.offset),
    db.select({ total: count() }).from(schema.agentRuns).where(where),
  ]);

  if (rows.length === 0) return { runs: [], total: totals?.total ?? 0 };

  const ids = rows.map((row) => row.id);
  const counts = await db
    .select({ runId: schema.agentSteps.runId, steps: count() })
    .from(schema.agentSteps)
    .where(and(eq(schema.agentSteps.organisationId, organisationId), inArray(schema.agentSteps.runId, ids)))
    .groupBy(schema.agentSteps.runId);
  const stepsByRun = new Map(counts.map((row) => [row.runId, row.steps]));

  return {
    runs: rows.map((run) => ({
      ...run,
      steps: stepsByRun.get(run.id) ?? 0,
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    })),
    total: totals?.total ?? 0,
  };
}

/** Every agent key that has ever run here, for the filter's options. */
export async function listAgentKeys(db: Db, organisationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentKey: schema.agentRuns.agentKey })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.organisationId, organisationId))
    .orderBy(schema.agentRuns.agentKey);
  return rows.map((row) => row.agentKey);
}

/**
 * How the agents have been getting on lately, for the strip above the list.
 *
 * A window rather than all time: "three failed" means nothing without "when",
 * and the number that matters on a Monday is what happened over the weekend.
 */
export async function agentRunHealth(db: Db, organisationId: string, since: Date): Promise<Record<(typeof AGENT_RUN_STATUSES)[number], number>> {
  const rows = await db
    .select({ status: schema.agentRuns.status, total: count() })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.organisationId, organisationId), gte(schema.agentRuns.startedAt, since)))
    .groupBy(schema.agentRuns.status);
  const health = { running: 0, completed: 0, awaiting_approval: 0, failed: 0 };
  for (const row of rows) health[row.status] = row.total;
  return health;
}
