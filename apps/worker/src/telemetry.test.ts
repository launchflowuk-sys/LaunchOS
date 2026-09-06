import { describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import { WorkerTelemetry, instrumentBoss, type JobFailure, type WorkerBoss } from "./telemetry.js";

type Handler = (jobs: PgBoss.JobWithMetadata<unknown>[]) => Promise<unknown>;

/** A boss that remembers what was registered and lets the test run a handler as pg-boss would. */
function fakeBoss() {
  const handlers = new Map<string, { options: PgBoss.WorkOptions; handler: Handler }>();
  const boss = {
    work: vi.fn(async (name: string, options: PgBoss.WorkOptions, handler: Handler) => {
      handlers.set(name, { options, handler });
      return `worker-${name}`;
    }),
    schedule: vi.fn(async () => undefined),
    send: vi.fn(async () => "job-id"),
    stop: vi.fn(async () => undefined),
  } as unknown as WorkerBoss;
  return { boss, handlers };
}

function job(retryCount: number, retryLimit = 2): PgBoss.JobWithMetadata<{ n: number }> {
  return { id: `job-${retryCount}`, name: "q", data: { n: 1 }, retryCount, retryLimit } as PgBoss.JobWithMetadata<{ n: number }>;
}

describe("WorkerTelemetry", () => {
  it("counts runs and failures per queue and remembers the last job time", () => {
    let now = new Date("2026-09-06T10:00:00Z");
    const telemetry = new WorkerTelemetry(() => now);
    telemetry.register("idle.queue");
    now = new Date("2026-09-06T10:00:30Z");
    telemetry.jobSucceeded("monitor.check");
    now = new Date("2026-09-06T10:01:00Z");
    telemetry.jobFailed("monitor.check", new Error("boom"));

    const snapshot = telemetry.snapshot();
    expect(snapshot.startedAt).toBe("2026-09-06T10:00:00.000Z");
    expect(snapshot.uptime).toBe(60);
    expect(snapshot.lastJobAt).toBe("2026-09-06T10:01:00.000Z");
    expect(snapshot.queues["idle.queue"]).toEqual({ runs: 0, failures: 0, lastRunAt: null, lastFailureAt: null, lastError: null });
    expect(snapshot.queues["monitor.check"]).toEqual({
      runs: 2, failures: 1, lastRunAt: "2026-09-06T10:01:00.000Z", lastFailureAt: "2026-09-06T10:01:00.000Z", lastError: "Error: boom",
    });
    // A later success clears the error but keeps the failure count.
    telemetry.jobSucceeded("monitor.check");
    expect(telemetry.snapshot().queues["monitor.check"]).toMatchObject({ runs: 3, failures: 1, lastError: null });
    // The snapshot is a copy.
    const before = telemetry.snapshot();
    telemetry.jobSucceeded("monitor.check");
    expect(before.queues["monitor.check"]!.runs).toBe(3);
  });
});

describe("instrumentBoss", () => {
  it("registers every handler with includeMetadata, passes the jobs through untouched, and records the outcome", async () => {
    const { boss, handlers } = fakeBoss();
    const telemetry = new WorkerTelemetry();
    const wrapped = instrumentBoss(boss, { telemetry });
    const seen: unknown[] = [];

    await wrapped.work<{ n: number }>("q", async ([j]) => { seen.push(j!.data); });
    await wrapped.work<{ n: number }>("q2", { batchSize: 1 }, async () => undefined);

    expect(handlers.get("q")!.options).toEqual({ includeMetadata: true });
    expect(handlers.get("q2")!.options).toEqual({ batchSize: 1, includeMetadata: true });
    await handlers.get("q")!.handler([job(0)]);
    expect(seen).toEqual([{ n: 1 }]);
    expect(telemetry.snapshot().queues["q"]).toMatchObject({ runs: 1, failures: 0 });
    expect(telemetry.snapshot().queues["q2"]).toMatchObject({ runs: 0 });
  });

  it("re-throws a failure so pg-boss records it, and calls the hook only on the last attempt", async () => {
    const { boss, handlers } = fakeBoss();
    const telemetry = new WorkerTelemetry();
    const failures: JobFailure[] = [];
    const wrapped = instrumentBoss(boss, { telemetry, onFinalFailure: async (f) => { failures.push(f); } });
    const error = new TypeError("no such client");
    await wrapped.work("q", async () => { throw error; });
    const handler = handlers.get("q")!.handler;

    // Attempts 1 and 2 of 3 (retryLimit 2): retried, nobody told.
    await expect(handler([job(0)])).rejects.toBe(error);
    await expect(handler([job(1)])).rejects.toBe(error);
    expect(failures).toEqual([]);
    // The last attempt: told once, still thrown.
    await expect(handler([job(2)])).rejects.toBe(error);
    expect(failures).toEqual([{ queue: "q", jobId: "job-2", error, retryCount: 2, retryLimit: 2 }]);
    expect(telemetry.snapshot().queues["q"]).toMatchObject({ runs: 3, failures: 3, lastError: "TypeError: no such client" });
  });

  it("swallows a failing hook — an alert about an error must not become a second error — and passes the rest through", async () => {
    const { boss, handlers } = fakeBoss();
    const logger = { error: vi.fn() };
    const wrapped = instrumentBoss(boss, {
      telemetry: new WorkerTelemetry(), logger, onFinalFailure: async () => { throw new Error("db down"); },
    });
    await wrapped.work("q", async () => { throw new Error("job broke"); });
    await expect(handlers.get("q")!.handler([job(0, 0)])).rejects.toThrow("job broke");
    expect(logger.error).toHaveBeenCalledWith({ queue: "q", jobId: "job-0" }, "job failure hook failed", expect.any(Error));

    await wrapped.schedule("q", "* * * * *", {}, { tz: "Europe/London" });
    await wrapped.send("q", { n: 1 }, { singletonKey: "k" });
    await wrapped.stop({ graceful: true });
    expect(boss.schedule).toHaveBeenCalledWith("q", "* * * * *", {}, { tz: "Europe/London" });
    expect(boss.send).toHaveBeenCalledWith("q", { n: 1 }, { singletonKey: "k" });
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true });
  });
});
