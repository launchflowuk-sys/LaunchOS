import { describe, expect, it } from "vitest";
import { joinMarketingPath } from "./links";

describe("joinMarketingPath", () => {
  it("leaves paths alone on the marketing host", () => {
    expect(joinMarketingPath("", "/")).toBe("/");
    expect(joinMarketingPath("", "/work")).toBe("/work");
    expect(joinMarketingPath("", "work/grays-cabline")).toBe("/work/grays-cabline");
  });

  it("prefixes /site everywhere else, including the home page", () => {
    expect(joinMarketingPath("/site", "/")).toBe("/site");
    expect(joinMarketingPath("/site", "/work")).toBe("/site/work");
    expect(joinMarketingPath("/site", "/contact")).toBe("/site/contact");
  });
});
