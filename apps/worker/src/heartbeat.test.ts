import { describe, expect, it, vi } from "vitest";
import { WORKER_HEARTBEAT_NAME, heartbeatAge } from "@launchos/core";
import { withTestDb } from "@launchos/db/test";
import { heartbeatDetails, startHeartbeat } from "./heartbeat.js";
import { WorkerTelemetry } from "./telemetry.js";

describe("heartbeatDetails", () => {
  it("is the telemetry snapshot plus the caller's facts, with the snapshot winning a clash", () => {
    const snapshot = new WorkerTelemetry().snapshot();
    expect(heartbeatDetails(snapshot, { pid: 42, uptime: "not mine" })).toEqual({ pid: 42, ...snapshot });
  });
});

describe("startHeartbeat", () => {
  it("writes the worker row with the snapshot on demand and on the interval, and logs rather than throws when it cannot", async () => {
    await withTestDb(async (db) => {
      const telemetry = new WorkerTelemetry();
      telemetry.jobSucceeded("monitor.check");
      const heartbeat = startHeartbeat({
        db, snapshot: () => telemetry.snapshot(), details: { pid: 42, healthPort: 3001 }, intervalMs: 60_000, logger: { error() {} },
      });
      try {
        await heartbeat.beat();
        const age = await heartbeatAge(db, { name: WORKER_HEARTBEAT_NAME });
        expect(age).not.toBeNull();
        expect(age!.ageMs).toBeLessThan(5_000);
        expect(age!.details).toMatchObject({ pid: 42, healthPort: 3001, queues: { "monitor.check": { runs: 1 } } });
        expect(typeof age!.details["uptime"]).toBe("number");
      } finally {
        heartbeat.stop();
      }
    });

    // A database that is not there: the beat logs and the process lives on.
    const logger = { error: vi.fn() };
    const broken = startHeartbeat({
      db: { insert: () => { throw new Error("connection refused"); } } as never,
      snapshot: () => new WorkerTelemetry().snapshot(), intervalMs: 60_000, logger,
    });
    try {
      await expect(broken.beat()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith("worker heartbeat failed", expect.any(Error));
    } finally {
      broken.stop();
    }
  });
});
