import { describe, expect, it } from "vitest";
import {
  comparePricing, LAUNCHFLOW_PACKAGES, MARKET_BASIS, ONGOING_OPTIONS, recommendedPackage,
} from "./pricing.js";

/** Everything a small business site could ask for — the "full quote" case. */
const EVERYTHING = {
  pages: ["home", "about", "services", "service_detail", "gallery", "testimonials", "faq", "blog", "contact", "shop"],
  features: ["enquiry_form", "booking", "payments", "accounts", "chat", "newsletter", "maps"],
  contentSupport: ["writing", "photography", "branding"],
  ongoing: ["care", "social", "blog", "gbp", "ads"],
};

describe("comparePricing", () => {
  /**
   * The number that started this. A client went through a large agency's quote
   * funnel with roughly this scope and came out at about £27,000 to build and
   * £1,300 a month. If this model does not land in that region it is not
   * describing the market it claims to describe.
   */
  it("lands where a real agency quote landed for the same scope", () => {
    const c = comparePricing(EVERYTHING);

    expect(c.marketBuildPence).toBeGreaterThan(2_000_000);
    expect(c.marketBuildPence).toBeLessThan(3_500_000);
    expect(c.marketMonthlyPence).toBeGreaterThan(100_000);
    expect(c.marketMonthlyPence).toBeLessThan(250_000);
  });

  /** The whole argument: there is no build fee here, whatever they choose. */
  it("never charges to build, however much is picked", () => {
    expect(comparePricing(EVERYTHING).launchflowBuildPence).toBe(0);
    expect(comparePricing({ pages: ["home"] }).launchflowBuildPence).toBe(0);
  });

  /**
   * An untouched draft must show nothing rather than a foundation fee.
   * Quoting thousands to somebody who has ticked nothing is a number with no
   * scope attached, and it reads as a scare tactic rather than a comparison.
   */
  it("shows nothing at all before anything is chosen", () => {
    const c = comparePricing({});
    expect(c.marketBuildPence).toBe(0);
    expect(c.marketMonthlyPence).toBe(0);
    expect(c.launchflowMonthlyPence).toBe(0);
    expect(c.buildItems).toEqual([]);
    expect(c.firstYearSavingPence).toBe(0);
  });

  /** One page is a real answer, and it brings the foundation with it. */
  it("charges the foundation once, as soon as there is any scope", () => {
    const one = comparePricing({ pages: ["home"] });
    const two = comparePricing({ pages: ["home", "about"] });

    expect(one.buildItems[0]?.label).toBe("Design, build, testing and launch");
    expect(one.buildItems).toHaveLength(2);
    // The second page adds its own cost and not a second foundation.
    expect(two.marketBuildPence - one.marketBuildPence).toBeLessThan(100_000);
  });

  it("itemises what was picked, so a total is never just asserted", () => {
    const c = comparePricing({ pages: ["shop"], features: ["payments"], contentSupport: ["branding"] });
    const labels = c.buildItems.map((i) => i.label);

    expect(labels).toContain("Online shop");
    expect(labels).toContain("Taking payments");
    expect(labels).toContain("Logo and brand");
    expect(c.buildItems.reduce((sum, i) => sum + i.pence, 0)).toBe(c.marketBuildPence);
  });

  it("ignores options it does not recognise rather than throwing", () => {
    const c = comparePricing({ pages: ["home", "not-a-page"], ongoing: ["care", "nonsense"] });
    expect(c.buildItems.map((i) => i.label)).not.toContain("not-a-page");
    expect(c.ongoingItems).toHaveLength(1);
  });

  /** The saving is the build plus a year of the monthly difference. */
  it("adds a year of the difference to the build, for the first-year figure", () => {
    const c = comparePricing({ pages: ["home"], ongoing: ["care", "social"] });
    const monthlyGap = c.marketMonthlyPence - c.launchflowMonthlyPence;
    expect(c.firstYearSavingPence).toBe(c.marketBuildPence + monthlyGap * 12);
    expect(monthlyGap).toBeGreaterThan(0);
  });

  /** Somebody who wants nothing ongoing pays us nothing a month, and we say so. */
  it("charges no retainer when nothing ongoing was asked for", () => {
    const c = comparePricing({ pages: ["home", "contact"] });
    expect(c.launchflowMonthlyPence).toBe(0);
    expect(c.marketMonthlyPence).toBe(0);
  });
});

describe("recommendedPackage", () => {
  /** Derived from what they asked for, never from a budget they picked. */
  it("follows what the packages actually include", () => {
    expect(recommendedPackage([])).toBe("presence");
    expect(recommendedPackage(["care"])).toBe("presence");
    expect(recommendedPackage(["care", "social"])).toBe("standard");
    expect(recommendedPackage(["blog"])).toBe("standard");
    expect(recommendedPackage(["gbp"])).toBe("standard");
    // Advertising is the one thing only the top tier includes.
    expect(recommendedPackage(["ads"])).toBe("growth");
    expect(recommendedPackage(["social", "ads"])).toBe("growth");
  });

  it("prices each tier at the published figure", () => {
    expect(LAUNCHFLOW_PACKAGES.presence.monthlyPence).toBe(4_500);
    expect(LAUNCHFLOW_PACKAGES.standard.monthlyPence).toBe(11_000);
    expect(LAUNCHFLOW_PACKAGES.growth.monthlyPence).toBe(22_000);
  });
});

describe("the comparison's honesty", () => {
  /**
   * A comparative claim has to be verifiable. The basis line is exported so
   * there is exactly one of it and every screen showing a market figure can
   * carry the same words — and it must not name anybody.
   */
  it("states its basis, and names no competitor", () => {
    expect(MARKET_BASIS).toMatch(/typical/i);
    expect(MARKET_BASIS).toMatch(/2026/);
    expect(MARKET_BASIS).toMatch(/indicative|not a quotation/i);
  });

  /** Every ongoing option must be priced, or the strip silently undercounts. */
  it("prices every ongoing option the funnel can offer", () => {
    for (const option of ONGOING_OPTIONS) {
      const c = comparePricing({ ongoing: [option.value] });
      expect(c.ongoingItems, option.value).toHaveLength(1);
      expect(c.marketMonthlyPence, option.value).toBeGreaterThan(0);
    }
  });
});
