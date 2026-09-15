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

/**
 * The pricing card they clicked, carried to the lead.
 *
 * Captured rather than asked: the brief already asks for a budget *range*,
 * which is the better question, so the plan rides along as intent and the
 * person answering the phone gets to open with "you were looking at Growth".
 */
describe("the plan they clicked", () => {
  it("maps onto the lead's attribution", () => {
    expect(attributionFromSessionSource({ plan: "growth", entry_route: "/start" })).toEqual({
      plan: "growth",
      landingPath: "/start",
    });
  });

  /**
   * A plan is intent, not acquisition. If it counted as a campaign then a
   * returning visitor clicking a second card would register as a fresh advert
   * touch and overwrite nothing useful while implying an ad click that never
   * happened — the same reason `entry_route` and `referrer` are excluded.
   */
  it("does not register as a later campaign touch", () => {
    // The guarantee is that a plan click never *creates* a later touch, which
    // is what `prefixLatestTouch` decides. Reading a hand-written
    // `latest_plan` back is deliberately left alone: the funnel cannot
    // produce one, and a key that somehow exists is data, not a bug —
    // `entry_route` is excluded on exactly the same terms.
    expect(prefixLatestTouch({ plan: "standard" })).toEqual({});
    expect(prefixLatestTouch({ plan: "standard", utm_source: "google" })).toEqual({
      [`${LATEST_TOUCH_PREFIX}utm_source`]: "google",
    });
  });

  /** A card click on an ad-driven visit keeps both facts. */
  it("sits alongside a campaign rather than replacing it", () => {
    expect(
      attributionFromSessionSource({ utm_source: "google", utm_medium: "cpc", plan: "presence", entry_route: "/pricing" }),
    ).toEqual({ utmSource: "google", utmMedium: "cpc", plan: "presence", landingPath: "/pricing" });
  });
});
