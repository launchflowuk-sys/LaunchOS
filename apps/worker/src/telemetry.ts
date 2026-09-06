import type PgBoss from "pg-boss";

/**
 * What the worker knows about itself, in one object the health endpoint
 * reads, the heartbeat writes to `system_heartbeats`, and the instrumented
 * `boss.work` keeps current. Counters only — no payloads, no error bodies
 * beyond one message per queue — because the snapshot goes into a row every
 * admin can read and an HTTP response anyone on the network can fetch.
 */

export interface QueueStats {
  /** Handler invocations since boot, successes and failures together. */
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastFailureAt: string | null;
  /** The last failure's message, truncated; null once a later run succeeds. */
  lastError: string | null;
}

export interface TelemetrySnapshot {
  startedAt: string;
  /** Seconds since boot. */
  uptime: number;
  /** When the most recent job handler finished, either way. */
  lastJobAt: string | null;
  queues: Record<string, QueueStats>;
}

const MAX_ERROR_CHARS = 300;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

export class WorkerTelemetry {
  private readonly startedAt: Date;
  private lastJobAt: Date | null = null;
  private readonly queues = new Map<string, QueueStats>();

  constructor(private readonly clock: () => Date = () => new Date()) {
    this.startedAt = clock();
  }

  /** The queue's counters, created on first sight so an idle queue still appears once registered. */
  register(queue: string): void {
    if (!this.queues.has(queue)) {
      this.queues.set(queue, { runs: 0, failures: 0, lastRunAt: null, lastFailureAt: null, lastError: null });
    }
  }

  jobSucceeded(queue: string): void {
    const now = this.clock();
    const stats = this.statsFor(queue);
    this.queues.set(queue, { ...stats, runs: stats.runs + 1, lastRunAt: now.toISOString(), lastError: null });
    this.lastJobAt = now;
  }

  jobFailed(queue: string, error: unknown): void {
    const now = this.clock();
    const stats = this.statsFor(queue);
    this.queues.set(queue, {
      ...stats,
      runs: stats.runs + 1,
      failures: stats.failures + 1,
      lastRunAt: now.toISOString(),
      lastFailureAt: now.toISOString(),
      lastError: errorMessage(error),
    });
    this.lastJobAt = now;
  }

  snapshot(): TelemetrySnapshot {
    const now = this.clock();
    return {
      startedAt: this.startedAt.toISOString(),
      uptime: Math.max(0, Math.round((now.getTime() - this.startedAt.getTime()) / 1000)),
      lastJobAt: this.lastJobAt?.toISOString() ?? null,
      queues: Object.fromEntries([...this.queues.entries()].map(([name, stats]) => [name, { ...stats }])),
    };
  }

  private statsFor(queue: string): QueueStats {
    this.register(queue);
    return this.queues.get(queue)!;
  }
}

/** What the final-attempt hook is told. */
export interface JobFailure {
  readonly queue: string;
  readonly jobId: string;
  readonly error: unknown;
  readonly retryCount: number;
  readonly retryLimit: number;
}

export interface InstrumentOptions {
  readonly telemetry: WorkerTelemetry;
  /**
   * Called once a job has used its last attempt — not on every retry, so a
   * flaky provider that recovers on the second try never alerts anyone. Its
   * own failure is logged and swallowed: an alert about an error must not
   * become a second error.
   */
  readonly onFinalFailure?: (failure: JobFailure) => Promise<void>;
  readonly logger?: Pick<Console, "error">;
}

/** The slice of pg-boss the worker registers against and sends through. */
export type WorkerBoss = Pick<PgBoss, "work" | "schedule" | "send" | "stop">;

/**
 * pg-boss has no "job failed for good" event, so this wraps `work`: every
 * handler runs with `includeMetadata` (which adds the attempt counters to
 * the job and changes nothing about `data`), the telemetry is updated either
 * way, and on the last attempt the failure hook fires before the error is
 * re-thrown for pg-boss to record. `schedule`, `send` and `stop` pass straight
 * through, so the result satisfies every `BossSender` / `BossRegistrar` the
 * jobs declare.
 */
export function instrumentBoss(boss: WorkerBoss, options: InstrumentOptions): WorkerBoss {
  const { telemetry } = options;
  const logger = options.logger ?? console;

  const work: WorkerBoss["work"] = (async (name: string, ...rest: unknown[]) => {
    telemetry.register(name);
    const handler = rest[rest.length - 1] as (jobs: PgBoss.JobWithMetadata<unknown>[]) => Promise<unknown>;
    const workOptions = (rest.length > 1 ? rest[0] : {}) as PgBoss.WorkOptions;
    const wrapped = async (jobs: PgBoss.JobWithMetadata<unknown>[]) => {
      try {
        const result = await handler(jobs);
        telemetry.jobSucceeded(name);
        return result;
      } catch (error) {
        telemetry.jobFailed(name, error);
        const job = jobs[0];
        if (job !== undefined && job.retryCount >= job.retryLimit && options.onFinalFailure) {
          await options.onFinalFailure({ queue: name, jobId: job.id, error, retryCount: job.retryCount, retryLimit: job.retryLimit })
            .catch((hookError: unknown) => logger.error({ queue: name, jobId: job.id }, "job failure hook failed", hookError));
        }
        throw error;
      }
    };
    return boss.work(name, { ...workOptions, includeMetadata: true }, wrapped);
  }) as WorkerBoss["work"];

  return {
    work,
    schedule: (...args) => boss.schedule(...args),
    send: ((...args: Parameters<PgBoss["send"]>) => boss.send(...args)) as WorkerBoss["send"],
    stop: (...args) => boss.stop(...args),
  };
}
