import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_NAME, recordHeartbeat } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { TelemetrySnapshot } from "./telemetry.js";

/**
 * "I am alive": the `worker` row in `system_heartbeats`, written at boot and
 * every minute after, carrying the same snapshot the health endpoint serves.
 * The admin layout reads the row's age (`checkWorkerDown`) and shows the
 * banner — and tells the owner once — when it goes stale. A failed write is
 * logged and the next tick tries again; the interval is `unref`'d so it never
 * keeps a stopping process alive.
 */

export interface HeartbeatOptions {
  readonly db: Db;
  readonly snapshot: () => TelemetrySnapshot;
  /** Extra facts worth showing next to the beat — the health port, the pid. */
  readonly details?: Record<string, unknown>;
  readonly intervalMs?: number;
  readonly logger?: Pick<Console, "error">;
}

export interface Heartbeat {
  /** One beat now, awaited. Boot calls it before the interval starts so the banner clears at once. */
  beat(): Promise<void>;
  stop(): void;
}

/** The row's `details`: the telemetry snapshot plus whatever the caller adds. */
export function heartbeatDetails(snapshot: TelemetrySnapshot, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, ...snapshot };
}

export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  const logger = options.logger ?? console;
  const beat = async () => {
    try {
      await recordHeartbeat(options.db, { name: WORKER_HEARTBEAT_NAME, details: heartbeatDetails(options.snapshot(), options.details) });
    } catch (error) {
      logger.error("worker heartbeat failed", error);
    }
  };
  const timer = setInterval(() => { void beat(); }, options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}
