import { describe, expect, it } from "vitest";
import { londonAt, londonOffsetMinutes, parsePeriodKey, spreadSlotTimes, weekdaysOf } from "./schedule.js";

const londonClock = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

describe("schedule", () => {
  it("parses a period key and refuses a bad one", () => {
    expect(parsePeriodKey("2026-09")).toEqual([2026, 9]);
    expect(() => parsePeriodKey("2026-13")).toThrow(/YYYY-MM/);
    expect(() => parsePeriodKey("Sept")).toThrow(/YYYY-MM/);
  });

  it("knows London is an hour ahead in summer and on UTC in winter", () => {
    expect(londonOffsetMinutes(new Date("2026-07-01T10:00:00Z"))).toBe(60);
    expect(londonOffsetMinutes(new Date("2026-01-15T10:00:00Z"))).toBe(0);
  });

  it("lands 10:00 London on the right UTC instant either side of the clock change", () => {
    expect(londonAt(2026, 9, 12, 10).toISOString()).toBe("2026-09-12T09:00:00.000Z");
    expect(londonAt(2026, 11, 12, 10).toISOString()).toBe("2026-11-12T10:00:00.000Z");
  });

  it("lists the weekdays of a month", () => {
    // September 2026 starts on a Tuesday and has 22 weekdays.
    const days = weekdaysOf("2026-09");
    expect(days).toHaveLength(22);
    expect(days[0]).toBe(1);
    expect(days).not.toContain(5);
    expect(days).not.toContain(6);
  });

  it("spreads four posts across the month on weekdays at 10:00 London", () => {
    const times = spreadSlotTimes("2026-09", 4);
    expect(times).toHaveLength(4);
    for (const t of times) {
      const clock = londonClock(t);
      expect(clock).toMatch(/10:00$/);
      expect(clock).not.toMatch(/^(Sat|Sun)/);
    }
    // 22 weekdays; the nth of four sits at n/5 of the way through them.
    expect(times.map((t) => t.getUTCDate())).toEqual([4, 11, 17, 24]);
    // Strictly increasing and inside the month.
    for (let i = 1; i < times.length; i += 1) expect(times[i]!.getTime()).toBeGreaterThan(times[i - 1]!.getTime());
  });

  it("puts a single post mid-month and shares days when there are more posts than weekdays", () => {
    const [one] = spreadSlotTimes("2026-09", 1);
    expect(one!.getUTCDate()).toBe(15);
    const many = spreadSlotTimes("2026-09", 30);
    expect(many).toHaveLength(30);
    expect(new Set(many.map((t) => t.getUTCDate())).size).toBeLessThanOrEqual(22);
    expect(spreadSlotTimes("2026-09", 0)).toEqual([]);
  });
});
