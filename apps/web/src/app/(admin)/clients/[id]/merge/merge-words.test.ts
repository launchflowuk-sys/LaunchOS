import { MOVE_SPECS } from "@launchos/core";
import { describe, expect, it } from "vitest";
import { countPhrase, describeCounts, hasWord, totalCount } from "./merge-words";

describe("merge words", () => {
  it("says a count the way the rail names things, singular and plural", () => {
    expect(countPhrase("subscriptions", 3)).toBe("3 subscriptions");
    expect(countPhrase("sites", 1)).toBe("1 site");
    expect(countPhrase("tickets", 2)).toBe("2 cases");
    expect(countPhrase("activity_events", 1)).toBe("1 timeline entry");
    expect(countPhrase("client_users", 1)).toBe("1 portal login");
  });

  it("falls back to the table name, readable, for a table it has no word for", () => {
    expect(countPhrase("client_widgets", 2)).toBe("2 client widgets");
    expect(countPhrase("client_widgets", 1)).toBe("1 client widget");
  });

  it("has a word for every table core can move, plus the billing profile", () => {
    // A new client-owned table lands here as soon as core's merge test admits it to MOVE_SPECS.
    for (const table of [...MOVE_SPECS.map((s) => s.key), "billing_profiles"]) expect(hasWord(table), table).toBe(true);
  });

  it("joins the counts in core's order and skips zeros", () => {
    expect(describeCounts({ subscriptions: 3, invoices: 2, sites: 1, tasks: 0 })).toBe("3 subscriptions, 2 invoices, 1 site");
    expect(describeCounts({})).toBe("");
    expect(totalCount({ subscriptions: 3, invoices: 2, sites: 1 })).toBe(6);
  });
});
