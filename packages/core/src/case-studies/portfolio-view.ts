import type {
  CaseStudyBrief,
  CaseStudyDeliveryStatus,
  CaseStudyPoweredBy,
  CaseStudyScreenshots,
} from "@launchos/db/schema";
import type { CaseStudySeed } from "./portfolio.js";
import type { CaseStudyRow } from "./shared.js";

/**
 * The two shapes the marketing pages actually render, built from a row.
 *
 * They are exactly the shapes the pages already consume — `work.ts`'s
 * `WorkItem` and `products.ts`'s `Product`, field for field — so swapping the
 * pages onto the database is a change of import and nothing else. Keeping the
 * mapping here rather than in the page means one place decides that a product
 * with no `tagline` is a bug and a client build with no `domain` is normal.
 */

export type PortfolioStatus = CaseStudyDeliveryStatus;

/** A client build, as the Work index and a `/work/<slug>` page read it. */
export interface PortfolioWorkItem {
  slug: string;
  name: string;
  /** Who it was for. For our own products, "LaunchFlow". */
  client: string;
  sector: string;
  url: string | null;
  summary: string;
  brief: CaseStudyBrief;
  stack: readonly string[];
  year: number;
  screenshots: CaseStudyScreenshots;
  featured: boolean;
  kind: "client";
  status: PortfolioStatus;
  charity?: boolean;
  poweredBy?: CaseStudyPoweredBy;
}

/** One of our own platforms, as the Products page reads it. */
export interface PortfolioProduct {
  slug: string;
  name: string;
  domain: string;
  url: string;
  tagline: string;
  description: string;
  facts: readonly string[];
  category: string;
  oneLine: string;
  flagship: boolean;
  status: PortfolioStatus;
  screenshots: CaseStudyScreenshots;
}

/**
 * A row read back as a client build.
 *
 * `charity` and `poweredBy` are omitted rather than set to `false`/`null`
 * because that is how the page's optional fields were written and how its
 * `item.poweredBy && …` guards read. `year` falls back to the year the row was
 * created: a client build always had one, and a card with a blank year looks
 * broken in a way that a slightly generous one does not.
 */
export function toWorkItem(row: CaseStudyRow): PortfolioWorkItem {
  return {
    slug: row.slug,
    name: row.name,
    client: row.clientName ?? row.name,
    sector: row.sector,
    url: row.url,
    summary: row.summary,
    brief: row.brief,
    stack: row.stack,
    year: row.year ?? row.createdAt.getUTCFullYear(),
    screenshots: row.screenshots,
    featured: row.featured,
    kind: "client",
    status: row.deliveryStatus,
    ...(row.charity ? { charity: true } : {}),
    ...(row.poweredBy ? { poweredBy: row.poweredBy } : {}),
  };
}

/**
 * A row read back as a product.
 *
 * `domain` falls back to the host of `url` because that is what every seeded
 * product's domain already is, and a product added later through the admin
 * form should not need the same string typed twice.
 */
export function toProduct(row: CaseStudyRow): PortfolioProduct {
  return {
    slug: row.slug,
    name: row.name,
    domain: row.domain ?? hostOf(row.url),
    url: row.url ?? "",
    tagline: row.tagline ?? row.summary,
    description: row.description ?? row.summary,
    facts: row.facts,
    category: row.sector,
    oneLine: row.summary,
    flagship: row.featured,
    status: row.deliveryStatus,
    screenshots: row.screenshots,
  };
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A row back in the shape the seed defines it, so a test can assert the round
 * trip in one comparison instead of twenty.
 */
export function toCaseStudySeed(row: CaseStudyRow): CaseStudySeed {
  return {
    slug: row.slug,
    name: row.name,
    clientName: row.clientName,
    sector: row.sector,
    summary: row.summary,
    brief: row.brief,
    stack: row.stack,
    year: row.year,
    url: row.url,
    screenshots: row.screenshots,
    featured: row.featured,
    kind: row.kind,
    deliveryStatus: row.deliveryStatus,
    charity: row.charity,
    poweredBy: row.poweredBy ?? null,
    domain: row.domain,
    tagline: row.tagline,
    description: row.description,
    facts: row.facts,
  };
}
