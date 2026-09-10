import { describe, expect, it } from "vitest";
import { directionFor, invoiceDatesFor, isDueToRaise, NOTICE_DEFAULT_DAYS } from "./invoice-dates.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("directionFor", () => {
  it("treats everything a person has to act on as billed in advance", () => {
    expect(directionFor("stripe")).toBe("arrears");
    for (const method of ["bank_transfer", "standing_order", "direct_debit", "cash", "other"]) {
      expect(directionFor(method)).toBe("advance");
    }
  });
});

describe("invoiceDatesFor", () => {
  /**
   * The case that started this. An invoice raised on 5 September came out due
   * 5 October, while the client had last paid on 4 August and was already a
   * month behind.
   */
  it("makes the money due on the period start and sends the notice before it", () => {
    const dates = invoiceDatesFor({
      periodStart: at("2026-09-05"),
      collectionMethod: "bank_transfer",
      noticeDays: 7,
    });

    expect(dates.dueAt).toEqual(at("2026-09-05"));
    expect(dates.issuedAt).toEqual(at("2026-08-29"));
    expect(dates.direction).toBe("advance");
  });

  it("defaults to a week of notice when nobody has said otherwise", () => {
    const dates = invoiceDatesFor({ periodStart: at("2026-10-05"), collectionMethod: "bank_transfer" });
    expect(dates.issuedAt).toEqual(at(`2026-09-28`));
    expect(NOTICE_DEFAULT_DAYS).toBe(7);
  });

  it("issues on the day itself when there is no notice period", () => {
    const dates = invoiceDatesFor({ periodStart: at("2026-09-05"), collectionMethod: "cash", noticeDays: 0 });
    expect(dates.issuedAt).toEqual(at("2026-09-05"));
    expect(dates.dueAt).toEqual(at("2026-09-05"));
  });

  /** A bad settings value must not quietly move when a client is chased. */
  it("clamps a nonsense notice rather than trusting it", () => {
    expect(invoiceDatesFor({ periodStart: at("2026-09-05"), collectionMethod: "bank_transfer", noticeDays: -30 }).issuedAt)
      .toEqual(at("2026-09-05"));
    expect(invoiceDatesFor({ periodStart: at("2026-09-05"), collectionMethod: "bank_transfer", noticeDays: 9999 }).issuedAt)
      .toEqual(new Date(at("2026-09-05").getTime() - 90 * 86_400_000));
  });

  it("leaves Stripe alone: its invoice is a record, dated the day it is written", () => {
    const dates = invoiceDatesFor({
      periodStart: at("2026-09-05"),
      collectionMethod: "stripe",
      noticeDays: 7,
      now: at("2026-09-07"),
    });

    expect(dates.issuedAt).toEqual(at("2026-09-07"));
    expect(dates.dueAt).toEqual(at("2026-09-07"));
    expect(dates.direction).toBe("arrears");
  });

  it("dates a Stripe record from the period when it is raised without a clock", () => {
    const dates = invoiceDatesFor({ periodStart: at("2026-09-05"), collectionMethod: "stripe" });
    expect(dates.issuedAt).toEqual(at("2026-09-05"));
  });
});

describe("isDueToRaise", () => {
  const dates = invoiceDatesFor({ periodStart: at("2026-09-05"), collectionMethod: "bank_transfer", noticeDays: 7 });

  it("is not due before the notice date", () => {
    expect(isDueToRaise(dates, at("2026-08-28"))).toBe(false);
  });

  it("is due on the notice date", () => {
    expect(isDueToRaise(dates, at("2026-08-29"))).toBe(true);
  });

  /** A job that missed its day must catch up, not skip somebody's month. */
  it("stays due after the notice date, so a missed run recovers", () => {
    expect(isDueToRaise(dates, at("2026-09-03"))).toBe(true);
  });
});
