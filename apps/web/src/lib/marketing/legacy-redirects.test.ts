import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS, legacyRedirectFor } from "./legacy-redirects.js";

describe("legacyRedirectFor", () => {
  it("sends an old page to its successor, with or without the trailing slash", () => {
    // Google holds these with the slash; Next strips it before the proxy runs.
    expect(legacyRedirectFor("/how-it-works/")).toBe("/services");
    expect(legacyRedirectFor("/how-it-works")).toBe("/services");
    expect(legacyRedirectFor("/home")).toBe("/");
    expect(legacyRedirectFor("/website-templates/plumber/")).toBe("/work");
    expect(legacyRedirectFor("/privacy-policy/")).toBe("/privacy");
  });

  it("leaves the old blog alone rather than lying about it", () => {
    // No successor exists. Sending a reader who followed a link about DMARC to
    // a sales page is worse than a 404, and Google treats it as one anyway.
    expect(legacyRedirectFor("/insights")).toBeNull();
    expect(legacyRedirectFor("/what-is-spf-dkim-and-dmarc-an-easy-guide-for-beginners/")).toBeNull();
    expect(legacyRedirectFor("/category/seo-tips")).toBeNull();
  });

  it("ignores WordPress machinery", () => {
    for (const p of ["/feed/", "/comments/feed/", "/wp-json/", "/wp-login.php", "/website-tips/feed/"]) {
      expect(legacyRedirectFor(p), p).toBeNull();
    }
  });

  it("never touches a page that exists today", () => {
    for (const p of ["/", "/pricing", "/services", "/contact", "/work", "/about", "/privacy", "/products"]) {
      expect(legacyRedirectFor(p), p).toBeNull();
    }
  });

  it("points every target at a real page, so no redirect lands on a 404", () => {
    const live = new Set(["/", "/work", "/products", "/services", "/pricing", "/about", "/contact", "/privacy"]);
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      expect(live.has(to), `${from} -> ${to}`).toBe(true);
    }
  });
});
