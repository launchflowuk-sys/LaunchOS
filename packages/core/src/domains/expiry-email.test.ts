import { describe, expect, it } from "vitest";
import { clientShouldHear, CLIENT_EXPIRY_THRESHOLDS } from "./expiry-email.js";
import { EXPIRY_THRESHOLD_DAYS } from "./expiry.js";

/**
 * Who hears about a domain running out, and when.
 *
 * The owner hears at every threshold because he is the one managing it. The
 * client hears only when *they* are the one who has to act — which is the rule
 * worth a test, because getting it wrong in either direction is expensive:
 * too eager and a client is emailed about a renewal we handle for them, which
 * produces a phone call rather than a renewal; too shy and a domain lapses
 * with nobody outside this building ever having been told.
 */

describe("clientShouldHear", () => {
  it("says nothing while the domain renews itself", () => {
    // Ours to watch, not theirs to worry about.
    for (const days of [60, 30, 14, 7, 1, 0]) {
      expect(clientShouldHear(days, true), `${days} days, auto-renew on`).toBe(false);
    }
  });

  it("tells them at thirty and seven days when auto-renew is off", () => {
    expect(clientShouldHear(30, false)).toBe(true);
    expect(clientShouldHear(7, false)).toBe(true);
  });

  it("stays quiet on the owner's other thresholds, so one domain is not five emails", () => {
    for (const days of [60, 14, 1]) {
      expect(clientShouldHear(days, false), `${days} days`).toBe(false);
    }
  });

  it("always tells them once it has actually gone, auto-renew or not", () => {
    // Auto-renew that was going to work has already failed by this point.
    expect(clientShouldHear(-1, true)).toBe(true);
    expect(clientShouldHear(-1, false)).toBe(true);
    expect(clientShouldHear(-40, true)).toBe(true);
  });

  it("only ever fires on days the owner is also warned about", () => {
    // The client's set is a subset of the owner's, so a client can never be
    // told about a crossing that produced no internal record of it.
    for (const day of CLIENT_EXPIRY_THRESHOLDS) {
      expect(EXPIRY_THRESHOLD_DAYS as readonly number[]).toContain(day);
    }
  });
});
