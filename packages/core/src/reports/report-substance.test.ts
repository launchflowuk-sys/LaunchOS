import type { ClientReportStats } from "@launchos/db/schema";
import { describe, expect, it } from "vitest";
import { reportHasSubstance } from "./report-substance.js";

/** A month in which genuinely nothing happened: every collector returned zero. */
const NOTHING: Partial<ClientReportStats> = {
  tasksDone: 0,
  tasksOpen: 0,
  uptimePercent: null,
  ticketsOpened: 0,
  ticketsResolved: 0,
  ads: null,
  incidents: { opened: 0, resolved: 0, openAtPeriodEnd: 0 },
  content: { published: 0, planned: 0 },
  satisfaction: null,
  payments: { received: 0, receivedPence: 0 },
  invoices: { issued: 0, paidPence: 0, outstandingPence: 0 },
  currency: null,
};

describe("reportHasSubstance", () => {
  /**
   * The case this exists for. Thirteen approval cards were queued for clients
   * whose month contained nothing at all — "there's no information, nothing has
   * happened" — because the sweep built, rendered and asked about a report for
   * every active client regardless of whether it had anything in it.
   */
  it("is false for a month in which nothing happened", () => {
    expect(reportHasSubstance(NOTHING)).toBe(false);
  });

  it("is false for an empty stats object, and for one with nothing but a currency", () => {
    expect(reportHasSubstance({})).toBe(false);
    expect(reportHasSubstance({ currency: "GBP" })).toBe(false);
  });

  it.each([
    ["work was delivered", { tasksDone: 1 }],
    ["a case was opened", { ticketsOpened: 1 }],
    ["a case was resolved", { ticketsResolved: 1 }],
    ["an incident happened", { incidents: { opened: 1, resolved: 1, openAtPeriodEnd: 0 } }],
    ["an incident is still open", { incidents: { opened: 0, resolved: 0, openAtPeriodEnd: 1 } }],
    ["a post went out", { content: { published: 1, planned: 4 } }],
    ["the client rated us", { satisfaction: { responses: 1, averageScore: 5 } }],
    ["money came in", { payments: { received: 1, receivedPence: 7500 } }],
    ["an invoice was issued", { invoices: { issued: 1, paidPence: 0, outstandingPence: 7500 } }],
    ["an invoice is outstanding", { invoices: { issued: 0, paidPence: 0, outstandingPence: 4500 } }],
    ["ads ran", { ads: { spendPence: 5000, clicks: 20, conversions: 0, roas: 0 } }],
  ] satisfies readonly [string, Partial<ClientReportStats>][])(
    "is true when %s",
    (_why, patch) => {
      expect(reportHasSubstance({ ...NOTHING, ...patch })).toBe(true);
    },
  );

  /**
   * Uptime is the deliberate exception, and the only judgment call in here.
   * A perfect month on a site nothing else happened to is the monitoring
   * dashboard, not an account report — so 100% on its own is not substance,
   * while any dip is, because a dip is the thing a client actually wants told.
   */
  it("treats a perfect month of uptime as nothing to report, and any dip as something", () => {
    expect(reportHasSubstance({ ...NOTHING, uptimePercent: 100 })).toBe(false);
    expect(reportHasSubstance({ ...NOTHING, uptimePercent: 99.98 })).toBe(true);
  });

  /**
   * A planned-but-unpublished month is the state every client is in before the
   * writer runs, and it is not something to send: "we planned four posts and
   * published none" is a report about us, not about them.
   */
  it("is false when content was planned but none published", () => {
    expect(reportHasSubstance({ ...NOTHING, content: { published: 0, planned: 4 } })).toBe(false);
  });

  /**
   * Zeroed ads are what an account with a paused campaign reports. The row
   * existing is not the same as the campaign having run.
   */
  it("is false when an ad account reported all zeroes", () => {
    expect(reportHasSubstance({ ...NOTHING, ads: { spendPence: 0, clicks: 0, conversions: 0, roas: 0 } })).toBe(false);
  });

  /**
   * Open tasks alone are work in progress, not a month's outcome. A document
   * whose only content is a list of things we have not finished is not one
   * anybody would choose to send.
   */
  it("is false when the only thing to say is that tasks are still open", () => {
    expect(reportHasSubstance({ ...NOTHING, tasksOpen: 3 })).toBe(false);
  });
});
