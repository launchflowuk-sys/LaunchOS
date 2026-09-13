import { describe, expect, it } from "vitest";
import {
  attributionFromSessionSource,
  latestAttributionFromSessionSource,
  LATEST_TOUCH_PREFIX,
  prefixLatestTouch,
} from "./lead-attribution.js";

describe("attributionFromSessionSource", () => {
  it("maps every campaign key the funnel records onto the lead's attribution", () => {
    expect(
      attributionFromSessionSource({
        utm_source: "facebook",
        utm_medium: "paid_social",
        utm_campaign: "launchflow_growth",
        utm_term: "web design essex",
        utm_content: "creative_a",
        utm_id: "23858",
        gclid: "Cj0KCQ",
        fbclid: "IwAR1",
        gbraid: "0AAAAA",
        wbraid: "Cj8KCQ",
        msclkid: "abc123",
        ttclid: "tt-9",
        referrer: "grow.launchflow.co.uk",
        entry_route: "/start",
      }),
    ).toEqual({
      utmSource: "facebook",
      utmMedium: "paid_social",
      utmCampaign: "launchflow_growth",
      utmTerm: "web design essex",
      utmContent: "creative_a",
      utmId: "23858",
      gclid: "Cj0KCQ",
      fbclid: "IwAR1",
      gbraid: "0AAAAA",
      wbraid: "Cj8KCQ",
      msclkid: "abc123",
      ttclid: "tt-9",
      referrer: "grow.launchflow.co.uk",
      landingPath: "/start",
    });
  });

  it("is empty for a direct visit, so an organic lead is never tagged as paid", () => {
    expect(attributionFromSessionSource({})).toEqual({});
    expect(attributionFromSessionSource({ entry_route: "/start" })).toEqual({ landingPath: "/start" });
  });

  it("ignores anything that is not a campaign key", () => {
    expect(attributionFromSessionSource({ email: "sam@example.com", utm_source: "google" })).toEqual({
      utmSource: "google",
    });
  });

  it("never reads a latest-touch key as the original", () => {
    const source = { utm_source: "google", [`${LATEST_TOUCH_PREFIX}utm_source`]: "facebook" };
    expect(attributionFromSessionSource(source).utmSource).toBe("google");
    expect(latestAttributionFromSessionSource(source).utmSource).toBe("facebook");
  });
});

describe("latestAttributionFromSessionSource", () => {
  it("is empty when the visitor only ever arrived once", () => {
    expect(latestAttributionFromSessionSource({ utm_source: "google" })).toEqual({});
  });
});

describe("prefixLatestTouch", () => {
  it("prefixes the campaign keys a second visit carried", () => {
    expect(prefixLatestTouch({ utm_source: "facebook", gclid: "Cj0" })).toEqual({
      [`${LATEST_TOUCH_PREFIX}utm_source`]: "facebook",
      [`${LATEST_TOUCH_PREFIX}gclid`]: "Cj0",
    });
  });

  it("drops the entry route, which is not a campaign", () => {
    // Otherwise every returning visitor who reopened a bookmark would be
    // recorded as a second touch, and the column would mean nothing.
    expect(prefixLatestTouch({ utm_source: "facebook", entry_route: "/start" })).toEqual({
      [`${LATEST_TOUCH_PREFIX}utm_source`]: "facebook",
    });
  });

  it("drops anything that is not a campaign key", () => {
    expect(prefixLatestTouch({ email: "sam@example.com" })).toEqual({});
  });

  it("never double-prefixes an already-prefixed key", () => {
    expect(prefixLatestTouch({ [`${LATEST_TOUCH_PREFIX}utm_source`]: "facebook" })).toEqual({});
  });
});
