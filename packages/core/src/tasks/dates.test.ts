import { describe, expect, it } from "vitest";
import { addDays, dueWithinPeriod, londonDateKey, periodBounds } from "./dates.js";

describe("task dates", () => {
  it("adds whole days without mutating the input", () => {
    const base = new Date("2026-10-01T09:00:00.000Z");
    expect(addDays(base, 14).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(base.toISOString()).toBe("2026-10-01T09:00:00.000Z");
  });

  it("bounds monthly, quarterly and weekly periods", () => {
    const now = new Date("2026-10-14T12:00:00.000Z"); // a Wednesday
    expect(periodBounds("monthly", now).key).toBe("2026-10");
    expect(periodBounds("monthly", now).start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodBounds("monthly", now).end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(periodBounds("quarterly", now).key).toBe("2026-Q4");
    expect(periodBounds("weekly", now).key).toBe("2026-W-2026-10-12");
    expect(periodBounds("none", now).key).toBe("2026-10");
  });

  it("spreads n tasks evenly inside the period", () => {
    const p = periodBounds("monthly", new Date("2026-10-14T12:00:00.000Z"));
    const dues = [1, 2, 3, 4].map((n) => dueWithinPeriod(p, n, 4).toISOString().slice(0, 10));
    expect(dues).toEqual(["2026-10-07", "2026-10-13", "2026-10-19", "2026-10-25"]);
    expect(dueWithinPeriod(p, 1, 1).toISOString().slice(0, 10)).toBe("2026-10-16");
  });

  it("formats a London date key", () => {
    // 00:30 UTC on 1 July is 01:30 British Summer Time, still the 1st.
    expect(londonDateKey(new Date("2026-07-01T00:30:00.000Z"))).toBe("2026-07-01");
    // 23:30 UTC on 30 June is 00:30 BST on 1 July.
    expect(londonDateKey(new Date("2026-06-30T23:30:00.000Z"))).toBe("2026-07-01");
  });
});
