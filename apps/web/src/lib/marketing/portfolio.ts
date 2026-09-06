import { listCaseStudies, toProduct, toWorkItem, type PortfolioProduct, type PortfolioStatus, type PortfolioWorkItem } from "@launchos/core";
import type { CaseStudyPoweredBy, CaseStudyScreenshots } from "@launchos/db/schema";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";

/**
 * The portfolio, read from the database.
 *
 * It used to be two typed arrays — `work.ts` and `products.ts` — which was the
 * right call while Shoji was the only editor and a pull request was the audit
 * trail. What changed is that a delivered project now writes its own story: the
 * row is created with the project, milestones append to it, the worker attaches
 * the launch screenshots and the Case Study Writer drafts the copy. None of
 * that can happen in a file compiled into the bundle, so the copy moved into
 * `packages/core/src/case-studies/portfolio*.ts`, the migration seeded it as
 * twenty published rows, and these pages read the rows.
 *
 * Nothing here reshapes anything: `toWorkItem` and `toProduct` in core return
 * exactly the objects the pages already consumed, field for field, so the
 * rendered pages are unchanged.
 *
 * **Published only.** A draft story — every project starts with one — must
 * never reach the public site, which is why the filter is in the one query
 * every caller goes through rather than in each page.
 */

export type WorkStatus = PortfolioStatus;
export type WorkScreenshots = CaseStudyScreenshots;
export type PoweredBy = CaseStudyPoweredBy;
export type WorkItem = PortfolioWorkItem;
export type Product = PortfolioProduct;

/** The words on the pill. The database keeps the hyphens the site already renders. */
export const STATUS_LABEL: Record<WorkStatus, string> = {
  live: "Live",
  "in-build": "In build",
  "in-testing": "In testing",
  discovery: "In discovery",
};

/** Seconds a portfolio read is reused before the database is asked again. */
export const PORTFOLIO_REVALIDATE_SECONDS = 300;

/** The cache tag the admin screens bust when a story is edited, ordered or unpublished. */
export const PORTFOLIO_CACHE_TAG = "case-studies";

/**
 * The home page's ceiling, not its target: `featured` is the flag on both
 * kinds, and this only stops the section growing without anyone noticing.
 * Six because the grid is three across, so five or six both fill their rows
 * tidily and a fifth project costs none of the other four its place.
 */
export const FEATURED_WORK_LIMIT = 6;

export type Portfolio = { work: readonly WorkItem[]; products: readonly Product[] };

const EMPTY: Portfolio = { work: [], products: [] };

/**
 * One read for both pages: published rows in page order, split by kind.
 *
 * `listCaseStudies` orders by `sort`, then age, then id — the order the admin
 * list drags into place — so the Work index, the Products page and the home
 * grid all read the same way round without any of them sorting again.
 */
async function readPortfolio(): Promise<Portfolio> {
  const organisationId = await publicOrganisationId();
  if (!organisationId) return EMPTY;
  const rows = await listCaseStudies(getDb(), organisationId, { status: "published", limit: 500 });
  return {
    work: rows.filter((row) => row.kind === "client").map(toWorkItem),
    products: rows.filter((row) => row.kind === "product").map(toProduct),
  };
}

/**
 * Cached for five minutes, exactly as the pricing page is: a story edited in
 * the admin reaches the public page within that window, and a visitor never
 * costs Postgres a query. `cache()` on top scopes it to one render pass, so a
 * page that wants the work *and* the products asks once.
 */
const cachedPortfolio = unstable_cache(readPortfolio, ["marketing-portfolio"], {
  revalidate: PORTFOLIO_REVALIDATE_SECONDS,
  tags: [PORTFOLIO_CACHE_TAG],
});

export const portfolio = cache(async (): Promise<Portfolio> => cachedPortfolio());

/** Every published client build, in page order. */
export async function workItems(): Promise<readonly WorkItem[]> {
  return (await portfolio()).work;
}

/** Every published product, in page order. */
export async function productItems(): Promise<readonly Product[]> {
  return (await portfolio()).products;
}

/** The builds on the home grid. Four at most, and the section takes three. */
export async function featuredWork(): Promise<readonly WorkItem[]> {
  return (await workItems()).filter((item) => item.featured).slice(0, FEATURED_WORK_LIMIT);
}

/** The four on the home page's product grid, and the rest, listed as taking shape. */
export async function flagshipProducts(): Promise<readonly Product[]> {
  return (await productItems()).filter((product) => product.flagship).slice(0, FEATURED_WORK_LIMIT);
}

export async function upcomingProducts(): Promise<readonly Product[]> {
  return (await productItems()).filter((product) => !product.flagship);
}

/** One brief, by the slug in its URL. Null is a 404, not an error. */
export async function findWork(slug: string): Promise<WorkItem | null> {
  return (await workItems()).find((item) => item.slug === slug) ?? null;
}
