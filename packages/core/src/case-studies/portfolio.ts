import type {
  CaseStudyBrief,
  CaseStudyDeliveryStatus,
  CaseStudyKind,
  CaseStudyPoweredBy,
  CaseStudyScreenshots,
} from "@launchos/db/schema";
import { PORTFOLIO_CLIENTS } from "./portfolio-clients.js";
import { PORTFOLIO_PRODUCTS } from "./portfolio-products.js";

/**
 * The portfolio as it stood the day it moved into the database.
 *
 * It lived in `apps/web/src/lib/marketing/work.ts` and `products.ts` — typed
 * objects, because for a year Shoji was the only editor and a pull request was
 * a better audit trail than a table. What changed is that a delivered project
 * now writes its own story: the row is created with the project, milestones
 * append to it, the worker attaches the screenshots and the Case Study Writer
 * drafts the copy for Shoji to approve. None of that can happen in a file that
 * is compiled into the bundle.
 *
 * So the arrays moved here, into `core`, where the migration and the seed can
 * both read them, and the marketing pages read the rows instead. This module
 * is the *starting* content and nothing else: once the rows exist they are the
 * truth, and editing this file changes nothing that is already seeded.
 */

/**
 * One row's worth of starting content — every field the two marketing arrays
 * carried between them, with the ones only clients use and the ones only
 * products use both present and both nullable.
 *
 * There is no publication `status` here: everything seeded is `published`,
 * because it is already on the live site and the point of the seed is that
 * deleting `work.ts` does not blank the Work page.
 */
export interface CaseStudySeed {
  slug: string;
  name: string;
  /** Who it was for, short. Null for our own products. */
  clientName: string | null;
  sector: string;
  summary: string;
  brief: CaseStudyBrief;
  stack: readonly string[];
  year: number | null;
  url: string | null;
  screenshots: CaseStudyScreenshots;
  featured: boolean;
  kind: CaseStudyKind;
  deliveryStatus: CaseStudyDeliveryStatus;
  charity: boolean;
  poweredBy: CaseStudyPoweredBy | null;
  domain: string | null;
  tagline: string | null;
  description: string | null;
  facts: readonly string[];
}

/**
 * Everything, clients first, in the order the pages already show them. The
 * index in this array becomes `sort`, so a freshly seeded organisation reads
 * the same way round as the live site does today.
 */
export const PORTFOLIO: readonly CaseStudySeed[] = [...PORTFOLIO_CLIENTS, ...PORTFOLIO_PRODUCTS];

export { PORTFOLIO_CLIENTS, PORTFOLIO_PRODUCTS };
export { CABIO } from "./portfolio-clients.js";

/** The slugs the seed owns, for a caller that wants to know what it will touch. */
export const PORTFOLIO_SLUGS: readonly string[] = PORTFOLIO.map((entry) => entry.slug);
