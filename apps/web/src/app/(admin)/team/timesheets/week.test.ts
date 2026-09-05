import { describe, expect, it } from "vitest";
import { dayShort, weekFromParam, weekLabel, weekNav } from "./week";

describe("weekFromParam", () => {
  it("snaps any day to its Monday", () => {
    expect(weekFromParam("2026-09-05")).toBe("2026-08-31");
    expect(weekFromParam("2026-08-31")).toBe("2026-08-31");
  });

  it("falls back to this week in London for a missing or malformed value", () => {
    const now = new Date("2026-09-05T23:30:00Z"); // still Saturday 5 Sept in London (BST)
    expect(weekFromParam(undefined, now)).toBe("2026-08-31");
    expect(weekFromParam("last-week", now)).toBe("2026-08-31");
    expect(weekFromParam(["2026-09-02"], now)).toBe("2026-08-31");
  });
});

describe("labels and navigation", () => {
  it("names the week and its days", () => {
    expect(weekLabel("2026-08-31")).toBe("Mon 31 Aug – Sun 6 Sept 2026");
    expect(dayShort("2026-08-31")).toBe("Mon 31");
  });

  it("steps a week either way and knows which week is now", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(weekNav("2026-08-31", now)).toEqual({
      previous: "2026-08-24",
      next: "2026-09-07",
      thisWeek: "2026-08-31",
      isThisWeek: true,
    });
    expect(weekNav("2026-08-24", now).isThisWeek).toBe(false);
  });
});
