import { describe, expect, it } from "vitest";
import { includesLines } from "./packages";

describe("includesLines", () => {
  it("lists only what the package includes, with sensible plurals", () => {
    expect(
      includesLines({ website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 }),
    ).toEqual([
      "Website hosting, care and updates",
      "Search engine optimisation",
      "4 social posts a month",
      "1 blog post a month",
      "2 Google Business Profile updates a month",
    ]);
    expect(includesLines({ website: false, seo: false, ads: true, socialPostsPerMonth: 0, blogPostsPerMonth: 2, gbpUpdatesPerMonth: 0 })).toEqual([
      "Ad management",
      "2 blog posts a month",
    ]);
  });
});
