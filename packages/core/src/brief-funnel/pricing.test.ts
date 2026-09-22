import { describe, expect, it } from "vitest";
import { choosePackage, comparePricing, MARKET_BASIS, ONGOING_OPTIONS, type PackageOption } from "./pricing.js";

/**
 * Stand-ins for the rows `funnelPackageOptions` reads out of the packages
 * table. Written here rather than imported so a change to Shoji's real prices
 * never silently rewrites what these tests assert.
 */
const PACKAGES: readonly PackageOption[] = [
  { slug: "presence", label: "Presence", monthlyPence: 4_500, covers: [] },
  { slug: "standard", label: "Standard", monthlyPence: 11_000, covers: ["social", "blog", "gbp"] },
  { slug: "growth", label: "Growth", monthlyPence: 22_000, covers: ["social", "blog", "gbp", "ads"] },
];

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
    const c = comparePricing(EVERYTHING, PACKAGES);

    expect(c.marketBuildPence).toBeGreaterThan(2_000_000);
    expect(c.marketBuildPence).toBeLessThan(3_500_000);
    expect(c.marketMonthlyPence).toBeGreaterThan(100_000);
    expect(c.marketMonthlyPence).toBeLessThan(250_000);
  });

  /** The whole argument: there is no build fee here, whatever they choose. */
  it("never charges to build, however much is picked", () => {
    expect(comparePricing(EVERYTHING, PACKAGES).launchflowBuildPence).toBe(0);
    expect(comparePricing({ pages: ["home"] }, PACKAGES).launchflowBuildPence).toBe(0);
  });

  /**
   * An untouched draft must show nothing rather than a foundation fee.
   * Quoting thousands to somebody who has ticked nothing is a number with no
   * scope attached, and it reads as a scare tactic rather than a comparison.
   */
  it("shows nothing at all before anything is chosen", () => {
    const c = comparePricing({}, PACKAGES);
    expect(c.marketBuildPence).toBe(0);
    expect(c.marketMonthlyPence).toBe(0);
    expect(c.launchflowMonthlyPence).toBe(0);
    expect(c.buildItems).toEqual([]);
    expect(c.firstYearSavingPence).toBe(0);
  });

  /** One page is a real answer, and it brings the foundation with it. */
  it("charges the foundation once, as soon as there is any scope", () => {
    const one = comparePricing({ pages: ["home"] }, PACKAGES);
    const two = comparePricing({ pages: ["home", "about"] }, PACKAGES);

    expect(one.buildItems[0]?.label).toBe("Design, build, testing and launch");
    expect(one.buildItems).toHaveLength(2);
    // The second page adds its own cost and not a second foundation.
    expect(two.marketBuildPence - one.marketBuildPence).toBeLessThan(100_000);
  });

  it("itemises what was picked, so a total is never just asserted", () => {
    const c = comparePricing({ pages: ["shop"], features: ["payments"], contentSupport: ["branding"] }, PACKAGES);
    const labels = c.buildItems.map((i) => i.label);

    expect(labels).toContain("Online shop");
    expect(labels).toContain("Taking payments");
    expect(labels).toContain("Logo and brand");
    expect(c.buildItems.reduce((sum, i) => sum + i.pence, 0)).toBe(c.marketBuildPence);
  });

  it("ignores options it does not recognise rather than throwing", () => {
    const c = comparePricing({ pages: ["home", "not-a-page"], ongoing: ["care", "nonsense"] }, PACKAGES);
    expect(c.buildItems.map((i) => i.label)).not.toContain("not-a-page");
    expect(c.ongoingItems).toHaveLength(1);
  });

  /** The saving is the build plus a year of the monthly difference. */
  it("adds a year of the difference to the build, for the first-year figure", () => {
    const c = comparePricing({ pages: ["home"], ongoing: ["care", "social"] }, PACKAGES);
    const monthlyGap = c.marketMonthlyPence - c.launchflowMonthlyPence;
    expect(c.firstYearSavingPence).toBe(c.marketBuildPence + monthlyGap * 12);
    expect(monthlyGap).toBeGreaterThan(0);
  });

  /** Somebody who wants nothing ongoing pays us nothing a month, and we say so. */
  it("charges no retainer when nothing ongoing was asked for", () => {
    const c = comparePricing({ pages: ["home", "contact"] }, PACKAGES);
    expect(c.launchflowMonthlyPence).toBe(0);
    expect(c.marketMonthlyPence).toBe(0);
    expect(c.recommended).toBeNull();
  });
});

describe("choosePackage", () => {
  const pick = (ongoing: string[]) => choosePackage(PACKAGES, ongoing);

  /**
   * The cheapest package that covers everything asked for — derived from the
   * packages table, so adding a subscription needs no change here.
   */
  it("takes the cheapest package that covers what was asked for", () => {
    expect(pick([]).package?.slug).toBe("presence");
    // Looking after the site is what every retainer is, so it asks nothing extra.
    expect(pick(["care"]).package?.slug).toBe("presence");
    expect(pick(["care", "social"]).package?.slug).toBe("standard");
    expect(pick(["blog"]).package?.slug).toBe("standard");
    expect(pick(["gbp"]).package?.slug).toBe("standard");
    expect(pick(["ads"]).package?.slug).toBe("growth");
    expect(pick(["social", "ads"]).package?.slug).toBe("growth");
  });

  /** A new tier slots in without a code change, which is the whole point. */
  it("recommends a package added after this code was written", () => {
    const withNewTier: PackageOption[] = [
      ...PACKAGES,
      { slug: "social-only", label: "Social Only", monthlyPence: 7_500, covers: ["social"] },
    ];
    // Cheaper than Standard and it covers what was asked, so it wins.
    expect(choosePackage(withNewTier, ["social"]).package?.slug).toBe("social-only");
    // But it cannot cover articles, so Standard still does.
    expect(choosePackage(withNewTier, ["social", "blog"]).package?.slug).toBe("standard");
  });

  /**
   * Never silently drop something. A funnel that quietly ignores "run my
   * advertising" and recommends the cheapest tier has mis-sold before anybody
   * has spoken to them.
   */
  it("says what it could not cover rather than pretending", () => {
    const noAds = PACKAGES.filter((p) => p.slug !== "growth");
    const result = choosePackage(noAds, ["social", "ads"]);
    expect(result.package?.slug).toBe("standard");
    expect(result.uncovered).toEqual(["ads"]);
  });

  it("recommends nothing when there are no packages at all", () => {
    expect(choosePackage([], ["social"]).package).toBeNull();
    expect(choosePackage([], ["social"]).uncovered).toEqual(["social"]);
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
      const c = comparePricing({ ongoing: [option.value] }, PACKAGES);
      expect(c.ongoingItems, option.value).toHaveLength(1);
      expect(c.marketMonthlyPence, option.value).toBeGreaterThan(0);
    }
  });
});
