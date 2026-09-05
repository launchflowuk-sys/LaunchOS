import { describe, expect, it } from "vitest";
import { addDays, dueWithinPeriod, londonDateKey, periodBounds, ukDateRange, ukLongDate } from "./dates.js";

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

  it("rolls a December monthly period into January of the next year", () => {
    const now = new Date("2026-12-14T12:00:00.000Z");
    const p = periodBounds("monthly", now);
    expect(p.key).toBe("2026-12");
    expect(p.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rolls a Q4 quarterly period into Q1 of the next year", () => {
    const now = new Date("2026-12-14T12:00:00.000Z");
    const p = periodBounds("quarterly", now);
    expect(p.key).toBe("2026-Q4");
    expect(p.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("spans the full 29 days of a leap February (2028) and centres accordingly", () => {
    const now = new Date("2028-02-29T12:00:00.000Z");
    const p = periodBounds("monthly", now);
    expect(p.key).toBe("2028-02");
    expect(p.start.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    // March 1st, not the non-leap-year 28-day end — confirms the span is
    // derived from real calendar length, not a hardcoded day count.
    expect(p.end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
    // The midpoint of a 29-day period is day 14.5: Feb 15th at noon. A
    // non-leap February's midpoint would land a half-day earlier.
    expect(dueWithinPeriod(p, 1, 1).toISOString()).toBe("2028-02-15T12:00:00.000Z");
  });
});

describe("UK long dates for client emails", () => {
  it("renders an IsoDate as day, month name, year", () => {
    expect(ukLongDate("2026-09-30")).toBe("30 September 2026");
    expect(ukLongDate("2026-01-01")).toBe("1 January 2026");
  });

  it("renders a Date in Europe/London, not UTC", () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July.
    expect(ukLongDate(new Date("2026-06-30T23:30:00Z"))).toBe("1 July 2026");
  });

  it("collapses a range inside one month, one year, or neither", () => {
    expect(ukDateRange("2026-08-01", "2026-08-31")).toBe("1 to 31 August 2026");
    expect(ukDateRange("2026-08-28", "2026-09-03")).toBe("28 August to 3 September 2026");
    expect(ukDateRange("2026-12-29", "2027-01-04")).toBe("29 December 2026 to 4 January 2027");
  });
});
