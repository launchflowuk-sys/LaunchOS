import { describe, expect, it } from "vitest";
import { briefDateLabel, briefExcerpt } from "./format";

describe("briefDateLabel", () => {
  it("names the stored calendar day, whatever the machine's zone", () => {
    expect(briefDateLabel("2026-09-09")).toBe("Wednesday 9 September 2026");
  });

  it("passes a value it cannot read straight through", () => {
    expect(briefDateLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("briefExcerpt", () => {
  it("takes the first non-empty lines as plain text", () => {
    const body = [
      "# Ops Brief — Wednesday",
      "",
      "Two things need you this morning.",
      "- **Approvals**: 3 waiting, oldest 14h — [Approvals](/approvals)",
      "- One incident open on *grayscabline.co.uk*",
      "Nothing else changed.",
    ].join("\n");
    expect(briefExcerpt(body)).toEqual([
      "Ops Brief — Wednesday",
      "Two things need you this morning.",
      "Approvals: 3 waiting, oldest 14h — Approvals",
    ]);
  });

  it("returns fewer lines when the brief is short", () => {
    expect(briefExcerpt("Nothing needs you today.\n\n", 3)).toEqual(["Nothing needs you today."]);
    expect(briefExcerpt("")).toEqual([]);
  });
});
