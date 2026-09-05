import { describe, expect, it } from "vitest";
import { dateToLondonInput, londonInputToDate } from "./schedule-input";

describe("londonInputToDate", () => {
  it("reads a summer-time reading as BST (UTC+1)", () => {
    expect(londonInputToDate("2026-09-12T10:00")?.toISOString()).toBe("2026-09-12T09:00:00.000Z");
  });

  it("reads a winter reading as GMT", () => {
    expect(londonInputToDate("2026-12-03T10:00")?.toISOString()).toBe("2026-12-03T10:00:00.000Z");
  });

  it("refuses anything that is not a datetime-local value", () => {
    expect(londonInputToDate("")).toBeUndefined();
    expect(londonInputToDate("12/09/2026 10:00")).toBeUndefined();
    expect(londonInputToDate("2026-13-40T10:00")).toBeUndefined();
  });
});

describe("dateToLondonInput", () => {
  it("round-trips through the input format in both seasons", () => {
    for (const reading of ["2026-09-12T10:00", "2026-12-03T10:00", "2026-03-29T00:30"]) {
      expect(dateToLondonInput(londonInputToDate(reading))).toBe(reading);
    }
  });

  it("is blank for nothing", () => {
    expect(dateToLondonInput(null)).toBe("");
    expect(dateToLondonInput(undefined)).toBe("");
    expect(dateToLondonInput(new Date(Number.NaN))).toBe("");
  });
});
