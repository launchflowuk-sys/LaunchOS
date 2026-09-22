/**
 * What this would cost somewhere else, and what it costs here.
 *
 * The reason this exists: a client went through a large agency's own quote
 * funnel and came out at roughly **£27,000 to build plus £1,300 a month** for
 * the same set of things LaunchFlow does on a retainer. That number is the
 * whole argument, and it only lands if the person sees it while they are
 * choosing — not in a proposal a week later.
 *
 * **The answer is not "cheaper", it is "no build fee".** A discount invites
 * haggling. "You pay nothing until it is built and you have approved it" does
 * not, and it is true, so that is the line this supports.
 *
 * ## On the market figures
 *
 * These are **typical UK agency rates for the same scope**, not a specific
 * competitor's prices, and the copy must say so wherever they appear. A
 * comparison has to be verifiable to be fair — naming a rival, or quoting a
 * number with nothing behind it, is the claim that gets challenged and then
 * withdrawn. `MARKET_BASIS` is the sentence that goes under any figure this
 * module produces; it is exported rather than written into a component so
 * there is one of it.
 *
 * Everything here is a pure function of the answers. No database, no request,
 * so the same numbers can be shown live in the funnel and recomputed on the
 * server without two implementations that drift.
 */

/** The line that must appear wherever these figures are shown. */
export const MARKET_BASIS =
  "Typical UK agency pricing for the same scope, gathered from published rates and quotes in 2026. Indicative, not a quotation from any named firm.";

/** One thing they picked, and what it costs the usual way. */
interface MarketItem {
  /** What a client would recognise, not our internal key. */
  label: string;
  /** One-off build cost, in pence. */
  buildPence: number;
}

/**
 * The foundation every agency charges for before a single page: discovery,
 * design, the build itself, testing and launch. Charged once, and the largest
 * single line on most quotes.
 */
const MARKET_FOUNDATION_PENCE = 350_000;

/** Pages, by the funnel's own `PAGES` values. */
const MARKET_PAGES: Readonly<Record<string, MarketItem>> = {
  home: { label: "Home page", buildPence: 90_000 },
  about: { label: "About page", buildPence: 55_000 },
  services: { label: "Services page", buildPence: 60_000 },
  service_detail: { label: "A page for each service", buildPence: 120_000 },
  gallery: { label: "Gallery", buildPence: 70_000 },
  testimonials: { label: "Reviews page", buildPence: 45_000 },
  faq: { label: "FAQ", buildPence: 40_000 },
  blog: { label: "Blog or news section", buildPence: 90_000 },
  contact: { label: "Contact page", buildPence: 50_000 },
  shop: { label: "Online shop", buildPence: 600_000 },
  other: { label: "Additional pages", buildPence: 60_000 },
};

/** Features, by the funnel's own `FEATURES` values. */
const MARKET_FEATURES: Readonly<Record<string, MarketItem>> = {
  enquiry_form: { label: "Enquiry form", buildPence: 45_000 },
  booking: { label: "Online booking", buildPence: 350_000 },
  payments: { label: "Taking payments", buildPence: 280_000 },
  accounts: { label: "Customer accounts", buildPence: 450_000 },
  chat: { label: "Live chat", buildPence: 60_000 },
  newsletter: { label: "Newsletter signup", buildPence: 50_000 },
  maps: { label: "Map and directions", buildPence: 30_000 },
  languages: { label: "A second language", buildPence: 240_000 },
  other: { label: "Other features", buildPence: 80_000 },
};

/** Things people need made for them, which agencies bill as extras. */
const MARKET_CONTENT: Readonly<Record<string, MarketItem>> = {
  writing: { label: "Writing the words", buildPence: 120_000 },
  photography: { label: "Photography", buildPence: 95_000 },
  branding: { label: "Logo and brand", buildPence: 180_000 },
};

/**
 * The ongoing work, and what it costs monthly elsewhere.
 *
 * `service` names the LaunchFlow switch it corresponds to, which is what makes
 * the recommendation below derived rather than guessed.
 */
const MARKET_ONGOING: Readonly<Record<string, { label: string; monthlyPence: number; service: string }>> = {
  care: { label: "Hosting, updates, backups and monitoring", monthlyPence: 15_000, service: "care" },
  social: { label: "Social media posts", monthlyPence: 45_000, service: "social" },
  blog: { label: "Articles written each month", monthlyPence: 40_000, service: "blog" },
  gbp: { label: "Google Business updates and local SEO", monthlyPence: 35_000, service: "gbp" },
  ads: { label: "Running your advertising", monthlyPence: 50_000, service: "ads" },
};

/** The ongoing options, for the funnel to render. Order is the order they appear. */
export const ONGOING_OPTIONS: readonly { value: string; label: string; hint: string }[] = [
  { value: "care", label: "Look after the website", hint: "Hosting, updates, backups, monitoring" },
  { value: "social", label: "Post on social media", hint: "Facebook and Instagram, written for you" },
  { value: "blog", label: "Write articles", hint: "Keeps the site fresh and found" },
  { value: "gbp", label: "Keep Google up to date", hint: "Your listing, posts and reviews" },
  { value: "ads", label: "Run advertising", hint: "Google and Meta, managed" },
];

/**
 * One of our packages, as the funnel needs to see it.
 *
 * **Shaped on the server from the `packages` table, never hardcoded here.**
 * The three tiers were literals in this file until it became clear Shoji will
 * add subscriptions — LaunchOS itself, a new tier, a one-off offering — and a
 * price written twice is a price that will disagree with itself the first time
 * one of them moves. The table is already the source of truth: it holds the
 * monthly figure, what the package includes and the Stripe price it bills on.
 *
 * `covers` is what `servicesPaidFor` says the package pays for, computed by
 * the caller because that function reaches for database types this module must
 * not import.
 */
export interface PackageOption {
  slug: string;
  label: string;
  monthlyPence: number;
  /** The service keys this package pays for: `social`, `blog`, `gbp`, `ads`. */
  covers: readonly string[];
}

export interface PricingComparison {
  /** What the same scope typically costs to build, elsewhere. */
  marketBuildPence: number;
  /** And what it typically costs a month, elsewhere. */
  marketMonthlyPence: number;
  /** What it costs to build with us. Zero, and the point of the whole screen. */
  launchflowBuildPence: 0;
  /** The package their choices land on, or null when nothing we sell covers them. */
  recommended: PackageOption | null;
  launchflowMonthlyPence: number;
  /**
   * Service keys they asked for that no active package covers. Never hidden:
   * a funnel that silently drops "run my advertising" and recommends the
   * cheapest tier has mis-sold before anybody has spoken to them.
   */
  uncovered: readonly string[];
  /** What they picked, priced, for the itemised view. Build items only. */
  buildItems: readonly { label: string; pence: number }[];
  /** The ongoing work they asked for, priced the usual way. */
  ongoingItems: readonly { label: string; pence: number }[];
  /** What they save in the first year — the build, plus twelve months of the difference. */
  firstYearSavingPence: number;
}

/** The answers this needs. A subset of the brief, so a partial draft works. */
export interface PricingAnswers {
  pages?: readonly string[] | undefined;
  features?: readonly string[] | undefined;
  contentSupport?: readonly string[] | undefined;
  ongoing?: readonly string[] | undefined;
}

/**
 * The cheapest package that covers everything they asked for.
 *
 * Derived from the packages table rather than a hardcoded ladder, so adding a
 * subscription — a new tier, LaunchOS itself — needs no change here: define it
 * with the right `includes` and the funnel starts recommending it. Sorting by
 * price and taking the first match is what makes "cheapest that covers" true
 * however many there are, and in whatever order they arrive.
 *
 * Returns what it could not cover alongside, rather than falling back to a
 * tier that does less than they asked for.
 */
export function choosePackage(
  options: readonly PackageOption[],
  ongoing: readonly string[],
): { package: PackageOption | null; uncovered: readonly string[] } {
  // `care` is what every retainer is: looking after the site is the floor, not
  // a line item, so no package needs to declare it.
  const wanted = ongoing.filter((o) => o !== "care");
  if (options.length === 0) return { package: null, uncovered: wanted };

  const byPrice = [...options].sort((a, b) => a.monthlyPence - b.monthlyPence);
  const covering = byPrice.find((option) => wanted.every((w) => option.covers.includes(w)));
  if (covering) return { package: covering, uncovered: [] };

  // Nothing covers the lot. Offer the one that covers the most, and say plainly
  // what is left over so it becomes a conversation rather than a surprise.
  const best = byPrice.reduce((a, b) =>
    b.covers.filter((c) => wanted.includes(c)).length > a.covers.filter((c) => wanted.includes(c)).length ? b : a,
  );
  return { package: best, uncovered: wanted.filter((w) => !best.covers.includes(w)) };
}

/** Adds up one group of picks against a rate table. */
function priceGroup(
  picked: readonly string[] | undefined,
  table: Readonly<Record<string, MarketItem>>,
): { items: { label: string; pence: number }[]; total: number } {
  const items: { label: string; pence: number }[] = [];
  let total = 0;
  for (const value of picked ?? []) {
    const item = table[value];
    if (!item) continue;
    items.push({ label: item.label, pence: item.buildPence });
    total += item.buildPence;
  }
  return { items, total };
}

/**
 * The comparison, from whatever has been answered so far.
 *
 * Safe on an empty draft: nothing picked means no foundation charge either,
 * because quoting £3,500 to somebody who has ticked nothing is a number with
 * no scope attached and reads as a scare tactic.
 */
export function comparePricing(
  answers: PricingAnswers,
  packages: readonly PackageOption[] = [],
): PricingComparison {
  const pages = priceGroup(answers.pages, MARKET_PAGES);
  const features = priceGroup(answers.features, MARKET_FEATURES);
  const content = priceGroup(answers.contentSupport, MARKET_CONTENT);

  const anythingPicked = pages.items.length + features.items.length + content.items.length > 0;
  const foundation = anythingPicked
    ? [{ label: "Design, build, testing and launch", pence: MARKET_FOUNDATION_PENCE }]
    : [];

  const buildItems = [...foundation, ...pages.items, ...features.items, ...content.items];
  const marketBuildPence =
    (anythingPicked ? MARKET_FOUNDATION_PENCE : 0) + pages.total + features.total + content.total;

  const ongoing = answers.ongoing ?? [];
  const ongoingItems: { label: string; pence: number }[] = [];
  let marketMonthlyPence = 0;
  for (const value of ongoing) {
    const item = MARKET_ONGOING[value];
    if (!item) continue;
    ongoingItems.push({ label: item.label, pence: item.monthlyPence });
    marketMonthlyPence += item.monthlyPence;
  }

  const chosen = ongoing.length === 0
    ? { package: null, uncovered: [] as readonly string[] }
    : choosePackage(packages, ongoing);
  const launchflowMonthlyPence = chosen.package?.monthlyPence ?? 0;

  return {
    marketBuildPence,
    marketMonthlyPence,
    launchflowBuildPence: 0,
    recommended: chosen.package,
    launchflowMonthlyPence,
    uncovered: chosen.uncovered,
    buildItems,
    ongoingItems,
    firstYearSavingPence:
      marketBuildPence + Math.max(0, marketMonthlyPence - launchflowMonthlyPence) * 12,
  };
}
