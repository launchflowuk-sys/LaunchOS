/**
 * Per-item isolation for the fan-out sweeps.
 *
 * Every cron sweep runs the same shape: take a list (organisations, clients,
 * ad accounts), do something per item, and do NOT let one bad item cost every
 * other item its turn. Without this, a single organisation whose data throws
 * aborts the loop before the rest are touched, pg-boss retries the whole job,
 * and it dies on the same row every time — the later organisations are never
 * swept at all.
 */

export interface SweepFailure {
  /** The id of the item that failed, so the log line points at a row. */
  readonly id: string;
  readonly error: unknown;
}

export interface SweepSummary {
  readonly processed: number;
  readonly failed: number;
  readonly failures: readonly SweepFailure[];
}

export interface SweepLogger {
  error(...args: unknown[]): void;
}

export interface SweepOptions<T> {
  /** Names the sweep in log lines and in the AggregateError message. */
  readonly label: string;
  /** The id recorded against a failure. */
  readonly id: (item: T) => string;
  readonly logger?: SweepLogger;
}

/**
 * Runs `run` for every item behind its own try/catch. Failures are logged with
 * the item's id and collected; the sweep always reaches the end of the list.
 * Never throws — the caller decides what a partial failure means (see
 * `throwOnSweepFailure`).
 */
export async function sweep<T>(
  items: readonly T[],
  options: SweepOptions<T>,
  run: (item: T) => Promise<unknown>,
): Promise<SweepSummary> {
  const logger = options.logger ?? console;
  const failures: SweepFailure[] = [];
  let processed = 0;

  for (const item of items) {
    const id = options.id(item);
    try {
      await run(item);
      processed += 1;
    } catch (error) {
      logger.error({ id, error }, `${options.label} failed for one item`);
      failures.push({ id, error });
    }
  }

  return { processed, failed: failures.length, failures };
}

/**
 * Re-throws a sweep's collected failures as one `AggregateError`.
 *
 * Called after the summary has been logged, so the job is still marked failed
 * and retried by pg-boss rather than silently reporting success on a sweep
 * that half worked. Every sweep here is idempotent, so re-running the items
 * that already succeeded costs a little work and changes nothing.
 */
export function throwOnSweepFailure(label: string, summary: SweepSummary): void {
  if (summary.failed === 0) return;
  throw new AggregateError(
    summary.failures.map((f) => f.error),
    `${label}: ${summary.failed} of ${summary.processed + summary.failed} failed (${summary.failures.map((f) => f.id).join(", ")})`,
  );
}
