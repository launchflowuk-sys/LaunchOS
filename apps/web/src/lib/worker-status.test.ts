import { describe, expect, it } from "vitest";
import { workerDownMessage } from "./worker-status";

describe("workerDownMessage", () => {
  it("says nothing while the worker is checking in", () => {
    expect(workerDownMessage({ down: false, seenAt: new Date(), ageMs: 30_000 })).toBeNull();
  });

  it("names the minutes since the last heartbeat", () => {
    expect(workerDownMessage({ down: true, seenAt: new Date(), ageMs: 7 * 60_000 + 20_000 })).toMatch(
      /^Background worker has not checked in for 7 minutes/,
    );
    expect(workerDownMessage({ down: true, seenAt: new Date(), ageMs: 60_000 })).toMatch(/for 1 minute —/);
  });

  it("says so when the worker has never checked in at all", () => {
    expect(workerDownMessage({ down: true, seenAt: null, ageMs: null })).toMatch(/never checked in/);
  });
});
