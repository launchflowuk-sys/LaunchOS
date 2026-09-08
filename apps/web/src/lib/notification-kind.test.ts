import { describe, expect, it } from "vitest";
import { categoryOf, iconOf, sourceLabel, timeAgo, toneOf } from "./notification-kind";

/**
 * These four functions are the whole reason the bell panel can tell a failed
 * payment from a booked meeting, and they work by *deriving* rather than
 * enumerating — which is exactly why they need tests. A kind nobody has written
 * yet still has to arrive correctly coloured, and the ordering of the suffix
 * lists is load-bearing in a way nothing in the code will shout about if it
 * breaks.
 */

describe("toneOf", () => {
  it("reads the event half, not the domain", () => {
    // Same domain, four different answers. If the domain leaked into the tone
    // every invoice notification would be red, including the paid ones.
    expect(toneOf("invoice.overdue")).toBe("critical");
    expect(toneOf("invoice.approval_requested")).toBe("attention");
    expect(toneOf("invoice.paid")).toBe("good");
    expect(toneOf("invoice.viewed")).toBe("info");
  });

  it("does not read a failure as its own success", () => {
    // The bug the longest-first ordering exists to prevent: `send_failed`
    // contains `sent`... no it does not, but `reply_rejected` contains no
    // `accepted` either — the real trap is that GOOD holds "sent" and CRITICAL
    // holds "send_failed", and CRITICAL must be consulted first.
    expect(toneOf("message.send_failed")).toBe("critical");
    expect(toneOf("message.sent")).toBe("good");
    expect(toneOf("proposal.send_rejected")).toBe("critical");
    expect(toneOf("approval.reply_rejected")).toBe("critical");
  });

  it("puts a request for a human above a plain notice, and below a failure", () => {
    expect(toneOf("project.client_review_requested")).toBe("attention");
    expect(toneOf("approval.approval_requested")).toBe("attention");
    expect(toneOf("content_item.change_requested")).toBe("attention");
    // ...but an approved review is good news, not another thing to do.
    expect(toneOf("project.client_review_approved")).toBe("good");
  });

  it("falls back to info for a kind nobody has written yet", () => {
    // The whole design premise: new kinds land every time a feature does, and
    // an unknown one must be quiet rather than alarming.
    expect(toneOf("teleporter.calibrated")).toBe("info");
    expect(toneOf("invoice.some_event_from_2027")).toBe("info");
  });

  it("treats a kind with no dot as having no event, so it cannot be urgent", () => {
    expect(toneOf("overdue")).toBe("info");
    expect(toneOf("")).toBe("info");
  });
});

describe("categoryOf", () => {
  it("files a notification under the part of the business it belongs to", () => {
    expect(categoryOf("invoice.overdue")).toBe("money");
    expect(categoryOf("ticket.escalated")).toBe("support");
    expect(categoryOf("site.down")).toBe("delivery");
    expect(categoryOf("agent.completed")).toBe("automation");
    expect(categoryOf("member.added")).toBe("organisation");
  });

  it("reads the domain half only, whatever the event says", () => {
    expect(categoryOf("invoice.paid")).toBe("money");
    expect(categoryOf("invoice.overdue")).toBe("money");
  });

  it("falls back to overview for an unknown domain", () => {
    expect(categoryOf("teleporter.calibrated")).toBe("overview");
    expect(categoryOf("")).toBe("overview");
  });
});

describe("iconOf", () => {
  it("gives a domain a stable icon, regardless of the event", () => {
    expect(iconOf("invoice.paid")).toBe(iconOf("invoice.overdue"));
  });

  it("gives different domains different icons", () => {
    expect(iconOf("invoice.paid")).not.toBe(iconOf("ticket.opened"));
  });

  it("always returns something renderable, including for an unknown domain", () => {
    // A missing icon would crash the row rather than degrade it.
    expect(iconOf("teleporter.calibrated")).toBeTruthy();
    expect(iconOf("")).toBeTruthy();
  });
});

describe("sourceLabel", () => {
  it("names the source in words", () => {
    expect(sourceLabel("stripe_sync.completed")).toBe("Stripe sync");
    expect(sourceLabel("invoice.overdue")).toBe("Invoice");
    expect(sourceLabel("ad_account.disconnected")).toBe("Ad account");
  });

  it("handles a kind with no dot", () => {
    expect(sourceLabel("system")).toBe("System");
  });

  it("does not throw on an empty kind", () => {
    expect(sourceLabel("")).toBe("");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms), now);

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("says 'just now' inside the first minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * SECOND)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(ago(5 * MINUTE)).toBe("5m ago");
    expect(ago(2 * HOUR)).toBe("2h ago");
    expect(ago(3 * DAY)).toBe("3 days ago");
  });

  it("says yesterday rather than '1 days ago'", () => {
    expect(ago(DAY)).toBe("yesterday");
  });

  it("switches to weeks and then months", () => {
    expect(ago(7 * DAY)).toBe("1 week ago");
    expect(ago(14 * DAY)).toBe("2 weeks ago");
    // Weeks run to just under five of them, so a month old is still counted
    // in weeks — "4 weeks ago" is more precise than "1 month ago" and is what
    // the panel should say.
    expect(ago(30 * DAY)).toBe("4 weeks ago");
    expect(ago(60 * DAY)).toBe("2 months ago");
  });

  it("singularises the one-week and one-month cases", () => {
    expect(ago(7 * DAY)).not.toContain("1 weeks");
    expect(ago(35 * DAY)).toBe("1 month ago");
  });

  it("never renders a negative age for a clock that is slightly ahead", () => {
    // Server and browser clocks disagree by a second or two all the time; the
    // panel must not print "-1m ago" because of it.
    expect(timeAgo(new Date(now.getTime() + 30 * SECOND), now)).toBe("just now");
    expect(timeAgo(new Date(now.getTime() + 10 * MINUTE), now)).toBe("just now");
  });
});
