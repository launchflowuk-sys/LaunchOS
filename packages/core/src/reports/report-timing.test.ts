import { describe, expect, it } from "vitest";
import { isReportDue, REPORT_LEAD_DAYS, reportTimingFor } from "./report-timing.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("reportTimingFor", () => {
  /**
   * The case the whole thing is for. Five days before a payment on the 5th is
   * 31 August — and on the 31st the finished month is July, so a naive "five
   * days early" would report July to somebody about to pay for September.
   */
  it("waits for the month to finish rather than reporting a stale one", () => {
    const timing = reportTimingFor({ paymentDate: at("2026-09-05") });

    expect(timing.periodStart).toEqual(at("2026-08-01"));
    expect(timing.periodEnd).toEqual(at("2026-09-01"));
    // 1 September, four days before payment — not 31 August with July's figures.
    expect(timing.sendFrom).toEqual(at("2026-09-01"));
  });

  it("uses the lead time when the month finished long before payment", () => {
    const timing = reportTimingFor({ paymentDate: at("2026-09-20") });

    expect(timing.periodStart).toEqual(at("2026-08-01"));
    expect(timing.sendFrom).toEqual(at("2026-09-15"));
  });

  it("reports the month before payment even when payment is on the 1st", () => {
    const timing = reportTimingFor({ paymentDate: at("2026-09-01") });

    expect(timing.periodStart).toEqual(at("2026-08-01"));
    expect(timing.periodEnd).toEqual(at("2026-09-01"));
    expect(timing.sendFrom).toEqual(at("2026-09-01"));
  });

  it("crosses a year boundary without losing December", () => {
    const timing = reportTimingFor({ paymentDate: at("2027-01-10") });

    expect(timing.periodStart).toEqual(at("2026-12-01"));
    expect(timing.periodEnd).toEqual(at("2027-01-01"));
    expect(timing.sendFrom).toEqual(at("2027-01-05"));
  });

  it("honours a client's own lead time, and clamps a nonsense one", () => {
    expect(reportTimingFor({ paymentDate: at("2026-09-20"), leadDays: 10 }).sendFrom).toEqual(at("2026-09-10"));
    expect(reportTimingFor({ paymentDate: at("2026-09-20"), leadDays: -5 }).sendFrom).toEqual(at("2026-09-20"));
    // Clamped to 28, so a lead time can never reach back past the month itself.
    expect(reportTimingFor({ paymentDate: at("2026-09-20"), leadDays: 9999 }).sendFrom).toEqual(at("2026-09-01"));
  });

  it("defaults to five days", () => {
    expect(REPORT_LEAD_DAYS).toBe(5);
  });
});

describe("isReportDue", () => {
  const timing = reportTimingFor({ paymentDate: at("2026-09-20") });

  it("is not due the day before", () => {
    expect(isReportDue(timing, at("2026-09-14"))).toBe(false);
  });

  it("is due on the day", () => {
    expect(isReportDue(timing, at("2026-09-15"))).toBe(true);
  });

  /** A worker that was down must catch up, not skip somebody's month. */
  it("stays due afterwards", () => {
    expect(isReportDue(timing, at("2026-09-19"))).toBe(true);
  });
});
