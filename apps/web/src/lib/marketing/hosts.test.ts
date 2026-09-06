import { describe, expect, it } from "vitest";
import {
  appHostFromEnv,
  isMarketingHost,
  marketingHostFromEnv,
  marketingPrefixFor,
  marketingRewriteTarget,
  requestHost,
} from "./hosts";

describe("marketing hosts", () => {
  it("defaults the two hosts and treats a blank value as unset", () => {
    expect(marketingHostFromEnv({})).toBe("launchflow.co.uk");
    expect(marketingHostFromEnv({ MARKETING_HOST: "  " })).toBe("launchflow.co.uk");
    expect(marketingHostFromEnv({ MARKETING_HOST: "Example.Test" })).toBe("example.test");
    expect(appHostFromEnv({})).toBe("os.launchflow.co.uk");
    expect(appHostFromEnv({ APP_HOST: "app.example.test" })).toBe("app.example.test");
  });

  it("reads the host behind Traefik first, then the plain Host header, without a port", () => {
    expect(requestHost(new Headers({ host: "localhost:3000" }))).toBe("localhost");
    expect(requestHost(new Headers({ host: "os.launchflow.co.uk", "x-forwarded-host": "LaunchFlow.co.uk" }))).toBe("launchflow.co.uk");
    expect(requestHost(new Headers({ "x-forwarded-host": "a.test, b.test" }))).toBe("a.test");
    expect(requestHost(new Headers())).toBe("");
  });

  it("recognises the marketing host and its www alias only", () => {
    expect(isMarketingHost("launchflow.co.uk", "launchflow.co.uk")).toBe(true);
    expect(isMarketingHost("www.launchflow.co.uk", "launchflow.co.uk")).toBe(true);
    expect(isMarketingHost("os.launchflow.co.uk", "launchflow.co.uk")).toBe(false);
    expect(isMarketingHost("localhost", "launchflow.co.uk")).toBe(false);
    expect(isMarketingHost("evil-launchflow.co.uk", "launchflow.co.uk")).toBe(false);
  });

  it("rewrites marketing paths under /site and leaves the app's own paths alone", () => {
    expect(marketingRewriteTarget("/")).toBe("/site");
    expect(marketingRewriteTarget("/work")).toBe("/site/work");
    expect(marketingRewriteTarget("/work/grays-cabline")).toBe("/site/work/grays-cabline");
    expect(marketingRewriteTarget("/site")).toBeNull();
    expect(marketingRewriteTarget("/site/work")).toBeNull();
    const untouched = [
      "/api/health",
      "/_next/static/x.js",
      "/sign-in",
      "/signup/done",
      "/after-sign-in",
      "/portal/invoices",
      "/book",
      "/book/done",
      "/book/r/abc123/calendar.ics",
      "/p",
      "/p/8Kd2mQ1xTn0Zr7Lb4Vc9Ws6Yh3Uj5Ge",
      "/d",
      "/d/8Kd2mQ1xTn0Zr7Lb4Vc9Ws6Yh3Uj5Ge",
      "/robots.txt",
      "/sitemap.xml",
      "/brand/launchflow-logo.png",
    ];
    for (const path of untouched) expect(marketingRewriteTarget(path), path).toBeNull();
    // A prefix match is not a segment match.
    expect(marketingRewriteTarget("/signup-bonus")).toBe("/site/signup-bonus");
    expect(marketingRewriteTarget("/bookshop")).toBe("/site/bookshop");
    // The proposal path must not swallow the marketing pricing page, and the
    // handover path must not swallow anything either.
    expect(marketingRewriteTarget("/pricing")).toBe("/site/pricing");
    expect(marketingRewriteTarget("/design")).toBe("/site/design");
  });

  it("prefixes links with /site everywhere except the marketing host", () => {
    expect(marketingPrefixFor("launchflow.co.uk", "launchflow.co.uk")).toBe("");
    expect(marketingPrefixFor("www.launchflow.co.uk", "launchflow.co.uk")).toBe("");
    expect(marketingPrefixFor("localhost", "launchflow.co.uk")).toBe("/site");
    expect(marketingPrefixFor("os.launchflow.co.uk", "launchflow.co.uk")).toBe("/site");
  });
});
