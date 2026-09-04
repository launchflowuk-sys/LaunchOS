import { describe, expect, it, vi } from "vitest";
import { sweep, throwOnSweepFailure } from "./sweep.js";

const opts = { label: "test sweep", id: (item: { id: string }) => item.id };

describe("sweep", () => {
  it("keeps going after one item throws and reports both counts", async () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const seen: string[] = [];
    const logger = { error: vi.fn() };

    const summary = await sweep(items, { ...opts, logger }, async (item) => {
      if (item.id === "b") throw new Error("bad row");
      seen.push(item.id);
    });

    // The point of the whole module: "b" failing does not cost "c" its turn.
    expect(seen).toEqual(["a", "c"]);
    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures.map((f) => f.id)).toEqual(["b"]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ id: "b" });
  });

  it("reports a clean sweep when nothing throws", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    const summary = await sweep(items, opts, async () => undefined);
    expect(summary).toEqual({ processed: 2, failed: 0, failures: [] });
  });

  it("does not throw by itself, so the caller can log the summary first", async () => {
    const items = [{ id: "a" }];
    const logger = { error: vi.fn() };
    await expect(
      sweep(items, { ...opts, logger }, async () => {
        throw new Error("boom");
      }),
    ).resolves.toMatchObject({ processed: 0, failed: 1 });
  });
});

describe("throwOnSweepFailure", () => {
  it("is a no-op for a clean sweep", () => {
    expect(() => throwOnSweepFailure("test", { processed: 3, failed: 0, failures: [] })).not.toThrow();
  });

  it("raises one AggregateError naming the failed ids so pg-boss retries the job", () => {
    const summary = {
      processed: 2,
      failed: 1,
      failures: [{ id: "org-1", error: new Error("bad row") }],
    };
    try {
      throwOnSweepFailure("overdue sweep", summary);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toContain("org-1");
      expect(aggregate.message).toContain("1 of 3 failed");
      expect(aggregate.errors).toHaveLength(1);
    }
  });
});
