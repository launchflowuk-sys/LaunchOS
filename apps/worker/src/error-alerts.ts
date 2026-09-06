import { noteSystemError } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { JobFailure } from "./telemetry.js";

/**
 * The worker telling the owner about its own errors. Three sources, one
 * sink: `noteSystemError` writes a `system.error` notification — once per
 * signature per hour, urgent, so it reaches the phone — and never throws.
 *
 * - A job that has used its last retry (`reportJobFailure`, wired through
 *   `instrumentBoss`'s final-attempt hook): pg-boss has given up on it, and
 *   nothing else will say so.
 * - An unhandled promise rejection: logged and reported; the process keeps
 *   running, because pg-boss's own handlers catch their errors and a stray
 *   rejection elsewhere is not worth dropping every in-flight job for.
 * - An uncaught exception: reported, then the process exits non-zero so the
 *   supervisor restarts it — Node's own default, kept, because state after
 *   an uncaught throw is not to be trusted.
 */

export interface ErrorAlertDeps {
  readonly db: Db;
  readonly logger?: Pick<Console, "error">;
}

const MAX_MESSAGE_CHARS = 2000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "Error";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "(no message)";
  return trimmed.length > MAX_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…` : trimmed;
}

/** `${jobName}:${error.name}` — the shape W1's throttle keys on. */
export function jobErrorSignature(queue: string, error: unknown): string {
  return `${queue}:${errorName(error)}`;
}

export function processErrorSignature(kind: "unhandledRejection" | "uncaughtException", error: unknown): string {
  return `process.${kind}:${errorName(error)}`;
}

/** A job's final failure → one `system.error` per (queue, error class) per hour. */
export async function reportJobFailure(deps: ErrorAlertDeps, failure: JobFailure): Promise<void> {
  const logger = deps.logger ?? console;
  try {
    await noteSystemError(deps.db, {
      source: "worker",
      signature: jobErrorSignature(failure.queue, failure.error),
      message: `Job ${failure.jobId} on ${failure.queue} failed on its last attempt (${failure.retryCount + 1} of ${failure.retryLimit + 1}): ${errorMessage(failure.error)}`,
      details: { queue: failure.queue, jobId: failure.jobId, retryCount: failure.retryCount, retryLimit: failure.retryLimit },
    });
  } catch (error) {
    logger.error({ queue: failure.queue, jobId: failure.jobId }, "could not record job failure alert", error);
  }
}

export async function reportProcessError(
  deps: ErrorAlertDeps,
  kind: "unhandledRejection" | "uncaughtException",
  error: unknown,
): Promise<void> {
  const logger = deps.logger ?? console;
  logger.error(`worker ${kind}`, error);
  try {
    await noteSystemError(deps.db, {
      source: "worker",
      signature: processErrorSignature(kind, error),
      message: errorMessage(error),
      details: { kind, stack: error instanceof Error ? (error.stack ?? null) : null },
    });
  } catch (recordError) {
    logger.error(`could not record worker ${kind} alert`, recordError);
  }
}

export interface ProcessAlertOptions extends ErrorAlertDeps {
  /** How the process ends after an uncaught exception; injectable so the test does not exit the runner. */
  readonly exit?: (code: number) => void;
  /** How long the alert write may take before the exit goes ahead without it. */
  readonly exitGraceMs?: number;
}

const DEFAULT_EXIT_GRACE_MS = 5_000;

/** Registers both handlers on `process`. Returns a function that removes them (tests). */
export function installProcessErrorAlerts(options: ProcessAlertOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const grace = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  const onRejection = (reason: unknown) => { void reportProcessError(options, "unhandledRejection", reason); };
  const onException = (error: unknown) => {
    const timer = setTimeout(() => exit(1), grace);
    timer.unref();
    void reportProcessError(options, "uncaughtException", error).finally(() => {
      clearTimeout(timer);
      exit(1);
    });
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
