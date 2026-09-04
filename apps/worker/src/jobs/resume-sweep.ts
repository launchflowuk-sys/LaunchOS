import { notifyOwner, recordAudit } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, max, sql } from "drizzle-orm";
import { QUEUE } from "../boss.js";
import type { BossSender } from "./dispatch-event.js";
import { z } from "zod";
import { sweep, throwOnSweepFailure, type SweepLogger, type SweepSummary } from "./sweep.js";

/**
 * How long a decision is given to be delivered by the web request that made it
 * before this sweep re-enqueues it. Short, because the only cost of a duplicate
 * is a deduped insert: the `agent.resume` queue is `short` and the key is
 * `resume:<approvalId>`, and the kernel's replay guards (`metadata.pending`
 * cleared, the `toolUseId` binding, the conditional claim in `reopen`) are what
 * actually enforce once-only execution.
 */
export const RESUME_UNDELIVERED_AFTER_MS = 30_000;

/**
 * The far edge of the window. A decision this old whose run is *still* parked
 * is not a delivery that was unlucky — every retry has been spent and the job
 * fails for a reason re-sending cannot fix (an unregistered tool, a payload
 * bound to a tool_use the run is no longer awaiting). Re-enqueueing it once a
 * minute for ever would bury every real failure in the queue's log, so the
 * sweep stops and the row stays visible under "Already decided" with its run
 * parked, for a human to look at.
 */
export const RESUME_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/**
 * How long a `running` run may go without finishing, and without recording a
 * step, before it is called stranded. Generous: an Opus run with a dozen turns
 * is a normal shape, and failing a run that is still working is worse than
 * leaving one to time out.
 */
export const RUN_STUCK_AFTER_MS = 30 * 60_000;

const RESUME_LABEL = "approval resume sweep";
const RESUME_GIVE_UP_LABEL = "approval resume give-up";
const STUCK_LABEL = "stranded agent run sweep";

/** Stamped on an approval once its give-up has been announced, so it is announced once. */
const GIVE_UP_NOTIFIED = "resumeGiveUpNotifiedAt";

export interface ResumeSweepDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly logger?: SweepLogger & { info(...args: unknown[]): void };
}

export interface UndeliveredResume {
  readonly approvalId: string;
  readonly runId: string;
  readonly decision: "approved" | "rejected";
  readonly note: string | null;
}

/**
 * Decisions whose `agent.resume` never arrived: the approval is decided, the
 * run it belongs to is still parked in `awaiting_approval` with its
 * `metadata.pending` intact, and the decision is between
 * `RESUME_UNDELIVERED_AFTER_MS` and `RESUME_GIVE_UP_AFTER_MS` old.
 *
 * That predicate is the whole point of this sweep. `decideApproval` commits the
 * decision and the web request then enqueues the job as a *fast path*;
 * `boss.send` is a single INSERT whose promise can reject after the row landed,
 * so a rejection there means "unknown", not "not queued". Rather than undo a
 * decision that may already have been carried out, we leave it standing and
 * re-drive delivery from here — idempotently, because the last predicate binds
 * the approval to *the tool call the run is actually waiting on*. A run that has
 * been claimed (`running`), finished (no `metadata.pending`) or **re-parked on a
 * later tool call** (a different `awaitingToolUseId`) therefore no longer
 * matches. That last case is the ordinary shape for both approval-gated agents —
 * two flagged ad accounts in one Sentinel run, a reply plus a DNS change in one
 * triage — and without the join a spent approval would be re-enqueued every
 * minute for 24 hours and refused by the kernel every time.
 */
export async function findUndeliveredResumes(
  db: Db,
  organisationId: string,
  now: Date,
): Promise<UndeliveredResume[]> {
  const cutoff = new Date(now.getTime() - RESUME_UNDELIVERED_AFTER_MS);
  const floor = new Date(now.getTime() - RESUME_GIVE_UP_AFTER_MS);
  const rows = await db
    .select({
      approvalId: schema.approvals.id,
      runId: schema.agentRuns.id,
      decision: schema.approvals.status,
      note: schema.approvals.decisionNote,
    })
    .from(schema.approvals)
    .innerJoin(
      schema.agentRuns,
      and(
        eq(schema.agentRuns.id, schema.approvals.runId),
        eq(schema.agentRuns.organisationId, schema.approvals.organisationId),
      ),
    )
    .where(
      and(
        eq(schema.approvals.organisationId, organisationId),
        isNotNull(schema.approvals.runId),
        inArray(schema.approvals.status, ["approved", "rejected"]),
        isNull(schema.approvals.deletedAt),
        lt(schema.approvals.decidedAt, cutoff),
        gt(schema.approvals.decidedAt, floor),
        eq(schema.agentRuns.status, "awaiting_approval"),
        isNull(schema.agentRuns.deletedAt),
        // The parked loop state. Without it there is nothing to resume, and a
        // job would only throw `no resumable pending state` five times over.
        sql`${schema.agentRuns.metadata} -> 'pending' is not null`,
        // …and the run must still be parked on *this* approval's tool call.
        // `payload.toolUseId` is the authoritative binding (`resume-agent.ts`'s
        // `ApprovalPayload` reads exactly this field, and `loadParked` compares
        // it against the same `awaitingToolUseId`), so this predicate matches if
        // and only if the resume the kernel would accept has not happened yet.
        sql`${schema.agentRuns.metadata} -> 'pending' ->> 'awaitingToolUseId' = ${schema.approvals.payload} ->> 'toolUseId'`,
      ),
    );

  return rows.map((row) => ({
    approvalId: row.approvalId,
    runId: row.runId,
    decision: row.decision as "approved" | "rejected",
    note: row.note,
  }));
}

/**
 * The same shape as `findUndeliveredResumes`, past the far edge of the window.
 *
 * `RESUME_GIVE_UP_AFTER_MS` is the point at which this sweep stops re-driving a
 * decision — and until now it was silent about it: the row simply stopped
 * matching, the run stayed parked, the decision stayed decided, and nobody was
 * told. That edge is the one moment a permanently un-resumable decision is
 * knowable, so it gets one notification, keyed on a metadata marker so a sweep
 * running every minute for the rest of the approval's life says it once.
 */
export async function findGivenUpResumes(
  db: Db,
  organisationId: string,
  now: Date,
): Promise<UndeliveredResume[]> {
  const floor = new Date(now.getTime() - RESUME_GIVE_UP_AFTER_MS);
  const rows = await db
    .select({
      approvalId: schema.approvals.id,
      runId: schema.agentRuns.id,
      decision: schema.approvals.status,
      note: schema.approvals.decisionNote,
    })
    .from(schema.approvals)
    .innerJoin(
      schema.agentRuns,
      and(
        eq(schema.agentRuns.id, schema.approvals.runId),
        eq(schema.agentRuns.organisationId, schema.approvals.organisationId),
      ),
    )
    .where(
      and(
        eq(schema.approvals.organisationId, organisationId),
        isNotNull(schema.approvals.runId),
        inArray(schema.approvals.status, ["approved", "rejected"]),
        isNull(schema.approvals.deletedAt),
        lte(schema.approvals.decidedAt, floor),
        eq(schema.agentRuns.status, "awaiting_approval"),
        isNull(schema.agentRuns.deletedAt),
        sql`${schema.agentRuns.metadata} -> 'pending' is not null`,
        sql`${schema.agentRuns.metadata} -> 'pending' ->> 'awaitingToolUseId' = ${schema.approvals.payload} ->> 'toolUseId'`,
        sql`${schema.approvals.metadata} ->> ${GIVE_UP_NOTIFIED} is null`,
      ),
    );
  return rows.map((row) => ({
    approvalId: row.approvalId,
    runId: row.runId,
    decision: row.decision as "approved" | "rejected",
    note: row.note,
  }));
}

/**
 * Tells the owner about every decision this sweep has stopped re-driving, once.
 *
 * The marker is stamped *after* the notification, on purpose: a crash between
 * the two costs a duplicate alert, and a duplicate is much cheaper than an
 * approved outward action that quietly never happened.
 */
export async function notifyGivenUpResumes(
  deps: Omit<ResumeSweepDeps, "boss">,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  const givenUp = await findGivenUpResumes(deps.db, organisationId, now);
  const summary = await sweep(
    givenUp,
    { label: RESUME_GIVE_UP_LABEL, id: (row) => row.approvalId, logger },
    async (row) => {
      await notifyOwner(deps.db, organisationId, {
        kind: "approval.resume_undelivered",
        title: `An ${row.decision} decision never reached its agent run`,
        body:
          "The resume sweep has re-enqueued it every minute for 24 hours and the run is still parked on this tool " +
          "call. It will not be retried again — the decision stands, but the action it authorised has not happened.",
        link: `/approvals`,
      });
      await deps.db
        .update(schema.approvals)
        .set({
          metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [GIVE_UP_NOTIFIED]: now.toISOString() })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.approvals.id, row.approvalId), eq(schema.approvals.organisationId, organisationId)));
    },
  );
  if (summary.processed > 0 || summary.failed > 0) {
    logger.info({ organisationId, gaveUp: summary.processed, failed: summary.failed }, RESUME_GIVE_UP_LABEL);
  }
  throwOnSweepFailure(RESUME_GIVE_UP_LABEL, summary);
  return summary;
}

/**
 * Re-enqueues every undelivered decision for one organisation, under the same
 * `resume:<approvalId>` key the web request uses, so a job already queued is
 * deduped rather than duplicated. Isolated per approval: one failed send must
 * not cost the rest of the sweep its turn.
 *
 * Also announces the give-up edge (`notifyGivenUpResumes`) on the way past,
 * because the two questions share a window and a cron tick.
 */
export async function runResumeSweep(
  deps: ResumeSweepDeps,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  // The give-up edge first: an approval that crossed it is about to stop
  // matching the re-enqueue query below. Its failures are logged rather than
  // thrown — an alert that cannot be written must not cost the decisions that
  // can still be delivered their re-enqueue.
  await notifyGivenUpResumes(deps, organisationId, now).catch((err: unknown) => {
    logger.error({ organisationId, err: String(err) }, "resume give-up notification failed");
  });
  const pending = await findUndeliveredResumes(deps.db, organisationId, now);
  const summary = await sweep(
    pending,
    { label: RESUME_LABEL, id: (row) => row.approvalId, logger },
    async (row) => {
      logger.info({ approvalId: row.approvalId, runId: row.runId }, "re-enqueueing an undelivered agent.resume");
      return deps.boss.send(
        QUEUE.agentResume,
        {
          organisationId,
          runId: row.runId,
          approvalId: row.approvalId,
          decision: row.decision,
          ...(row.note ? { note: row.note } : {}),
        },
        { singletonKey: `resume:${row.approvalId}` },
      );
    },
  );
  if (summary.processed > 0 || summary.failed > 0) {
    logger.info({ organisationId, requeued: summary.processed, failed: summary.failed }, RESUME_LABEL);
  }
  throwOnSweepFailure(RESUME_LABEL, summary);
  return summary;
}

export interface StuckRun {
  readonly id: string;
  readonly agentKey: string;
  readonly claimedAt: string | null;
  readonly lastActivityAt: Date;
}

/** What `RunRecorder.reopen` stamps on a run it claimed for an approval. */
const ResumeClaimedAt = z.object({ resume: z.object({ claimedAt: z.string().min(1) }) });

/**
 * Runs left `running` by a delivery that died. Two shapes, both covered by one
 * predicate — no step recorded for `RUN_STUCK_AFTER_MS`, and (for a resumed
 * run) a `metadata.resume.claimedAt` at least that old:
 *
 * - a resume that claimed the run and was killed before it could finish it;
 * - a first run whose process died mid-loop.
 *
 * A run that is visibly working — a step written in the last half hour — is
 * never eligible however long it has been going, which is what stops this
 * sweep failing a legitimately long Opus run.
 */
export async function findStuckRuns(db: Db, organisationId: string, now: Date): Promise<StuckRun[]> {
  const runs = await db
    .select({
      id: schema.agentRuns.id,
      agentKey: schema.agentRuns.agentKey,
      startedAt: schema.agentRuns.startedAt,
      metadata: schema.agentRuns.metadata,
    })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.organisationId, organisationId),
        eq(schema.agentRuns.status, "running"),
        isNull(schema.agentRuns.deletedAt),
      ),
    );
  if (runs.length === 0) return [];

  const steps = await db
    .select({ runId: schema.agentSteps.runId, lastStepAt: max(schema.agentSteps.createdAt) })
    .from(schema.agentSteps)
    .where(
      and(
        // The run ids are already org-scoped, so this changes no row — CLAUDE.md
        // rule 1 says every query filters on organisation_id all the same.
        eq(schema.agentSteps.organisationId, organisationId),
        inArray(schema.agentSteps.runId, runs.map((run) => run.id)),
      ),
    )
    .groupBy(schema.agentSteps.runId);
  const lastStepByRun = new Map(steps.map((row) => [row.runId, row.lastStepAt]));

  const cutoff = now.getTime() - RUN_STUCK_AFTER_MS;
  return runs.flatMap((run) => {
    // `startedAt` stands in for a run that has not managed a single step yet.
    const lastActivity = lastStepByRun.get(run.id) ?? run.startedAt;
    if (lastActivity.getTime() > cutoff) return [];
    const claimedAt = ResumeClaimedAt.safeParse(run.metadata);
    const claimed = claimedAt.success ? Date.parse(claimedAt.data.resume.claimedAt) : Number.NaN;
    // A claim newer than the cutoff means another delivery reopened this run
    // recently and is presumably working; leave it alone.
    if (Number.isFinite(claimed) && claimed > cutoff) return [];
    return [{
      id: run.id,
      agentKey: run.agentKey,
      claimedAt: claimedAt.success ? claimedAt.data.resume.claimedAt : null,
      lastActivityAt: lastActivity,
    }];
  });
}

/**
 * Fails every stranded run for one organisation, audits it as
 * `agent.run_stranded` and tells the owner.
 *
 * This is the *only* mechanism that closes a stranded run. The kernel used to
 * carry an in-band five-minute `failStrandedRun` as well; it compared a
 * timestamp rather than activity, so a redelivery landing mid-flight could fail
 * a resume that was still working. It is gone — a late delivery for a `running`
 * run now logs and no-ops, and this sweep decides, on evidence, when the run is
 * really dead.
 *
 * The `status = 'running'` predicate on the UPDATE is the same one
 * `RunRecorder.finish` carries, and the pair is what makes this safe: a run
 * this sweep failed cannot later be written back to `completed` by a resume
 * that comes back to life, and a run that finished normally between the read
 * and the write is not touched here.
 *
 * The status flip and its `audit_log` row are **one transaction**, so a failed
 * run is never durable without its audit trail (CLAUDE.md rule 3) — a retry
 * after a mid-write failure finds the run still `running` and does the whole
 * thing again. The notification is best effort *after* the commit: it must not
 * cost the sweep its correctness, and a retry would find the run already
 * `failed` and write neither the audit row nor the notification.
 */
export async function runStuckRunSweep(
  deps: Omit<ResumeSweepDeps, "boss">,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  const stuck = await findStuckRuns(deps.db, organisationId, now);
  const summary = await sweep(
    stuck,
    { label: STUCK_LABEL, id: (run) => run.id, logger },
    async (run) => {
      const error = `Stranded: the run has been running with no activity since ${run.lastActivityAt.toISOString()}${
        run.claimedAt ? ` (claimed for an approval at ${run.claimedAt})` : ""
      }.`;
      const claimed = await deps.db.transaction(async (tx) => {
        const inner = tx as unknown as Db;
        const [failed] = await tx
          .update(schema.agentRuns)
          .set({ status: "failed", summary: "Run stranded", error, finishedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.agentRuns.id, run.id),
              eq(schema.agentRuns.organisationId, organisationId),
              eq(schema.agentRuns.status, "running"),
              isNull(schema.agentRuns.deletedAt),
            ),
          )
          .returning({ id: schema.agentRuns.id });
        if (!failed) return false;

        await recordAudit(inner, organisationId, {
          actorKind: "system",
          action: "agent.run_stranded",
          targetType: "agent_run",
          targetId: run.id,
          before: { status: "running", lastActivityAt: run.lastActivityAt.toISOString(), claimedAt: run.claimedAt },
          after: { status: "failed", error },
        });
        return true;
      });
      if (!claimed) return;

      // An approved outward action may have vanished with the process that was
      // running it. Nothing else surfaces that — but a notification that cannot
      // be delivered must not fail the item either: the retry would find the run
      // already `failed` and skip the audit row as well.
      await notifyOwner(deps.db, organisationId, {
        kind: "agent.run_stranded",
        title: `${run.agentKey} stopped without finishing`,
        body: error,
        link: `/agents/runs/${run.id}`,
      }).catch((err: unknown) => {
        logger.error({ runId: run.id, err: String(err) }, "stranded-run notification failed; the run is failed and audited");
      });
    },
  );
  if (summary.processed > 0 || summary.failed > 0) {
    logger.info({ organisationId, stranded: summary.processed, failed: summary.failed }, STUCK_LABEL);
  }
  throwOnSweepFailure(STUCK_LABEL, summary);
  return summary;
}
