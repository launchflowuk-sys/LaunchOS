import { describe, expect, it } from "vitest";
import { optionLines, parseOptionLines, slugify, UpdateFunnelSchema } from "./schemas";

describe("funnel option lines", () => {
  it("reads `Label | points` and survives a round trip through the textarea", () => {
    const parsed = parseOptionLines("More enquiries | 30\nA new website|25\n  Just looking | -10  ");
    expect(parsed).toEqual([
      { value: "more-enquiries", label: "More enquiries", points: 30 },
      { value: "a-new-website", label: "A new website", points: 25 },
      { value: "just-looking", label: "Just looking", points: -10 },
    ]);
    expect(parseOptionLines(optionLines(parsed))).toEqual(parsed);
  });

  it("defaults a missing score to zero and drops a line with no label", () => {
    expect(parseOptionLines("Not sure yet")).toEqual([{ value: "not-sure-yet", label: "Not sure yet", points: 0 }]);
    expect(parseOptionLines("\n | 40 \n")).toEqual([]);
    expect(parseOptionLines(undefined)).toEqual([]);
  });

  it("makes a key out of a label the way a URL segment is made", () => {
    expect(slugify("£250 – £500")).toBe("250-500");
    expect(slugify("  Yes, please!  ")).toBe("yes-please");
  });
});

describe("UpdateFunnelSchema", () => {
  const base = {
    funnelId: "8f1f0c2a-4d16-4bd9-9c0f-1a0f2b3c4d5e",
    name: "Website enquiry",
    slug: "website-enquiry",
    hotScore: "55",
    successHeadline: "Thank you",
  };

  it("takes the threshold as a number and refuses a negative one", () => {
    expect(UpdateFunnelSchema.parse(base).hotScore).toBe(55);
    expect(UpdateFunnelSchema.safeParse({ ...base, hotScore: "-1" }).error?.issues[0]?.message).toMatch(/cannot be negative/);
  });

  it("refuses a web address that is not one", () => {
    expect(UpdateFunnelSchema.safeParse({ ...base, slug: "Website Enquiry" }).error?.issues[0]?.message)
      .toMatch(/lower-case letters, numbers and hyphens/);
    expect(UpdateFunnelSchema.safeParse({ ...base, successCtaUrl: "launchflow.co.uk/book" }).error?.issues[0]?.message)
      .toMatch(/full web address/);
  });
});
