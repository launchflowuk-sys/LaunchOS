import { listPackages } from "@launchos/core";
import type { PackageIncludes } from "@launchos/db/schema";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { formatPence } from "@/lib/format";
import { publicOrganisationId } from "@/lib/public-organisation";

/** A package as the pricing page shows it: strings only, so it survives the cache. */
export type PricingPackage = {
  slug: string;
  name: string;
  description: string | null;
  monthlyPrice: string;
  setupPrice: string | null;
  includes: readonly string[];
};

/** Seconds a pricing read is reused before the database is asked again. */
export const PRICING_REVALIDATE_SECONDS = 300;

/**
 * What the package gives you, as a short list a buyer can read in a glance.
 * The same lines `/signup` prints, so the pricing page and the sign-up form
 * cannot describe one package two ways.
 */
export function includesLines(includes: PackageIncludes): string[] {
  const lines: string[] = [];
  if (includes.website) lines.push("Website hosting, care and updates");
  if (includes.seo) lines.push("Search engine optimisation");
  if (includes.ads) lines.push("Ad management");
  if (includes.socialPostsPerMonth > 0) lines.push(`${includes.socialPostsPerMonth} social posts a month`);
  if (includes.blogPostsPerMonth > 0) lines.push(`${includes.blogPostsPerMonth} blog post${includes.blogPostsPerMonth === 1 ? "" : "s"} a month`);
  if (includes.gbpUpdatesPerMonth > 0) lines.push(`${includes.gbpUpdatesPerMonth} Google Business Profile updates a month`);
  return lines;
}

async function readPricingPackages(): Promise<PricingPackage[]> {
  const organisationId = await publicOrganisationId();
  if (!organisationId) return [];
  const packages = await listPackages(getDb(), organisationId, { activeOnly: true });
  // Cheapest first, so the last card — the one the page outlines — is the fullest plan.
  const byPrice = [...packages].sort((a, b) => a.monthlyPricePence - b.monthlyPricePence);
  return byPrice.map((pkg) => ({
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    monthlyPrice: formatPence(pkg.monthlyPricePence, pkg.currency),
    setupPrice: pkg.setupPricePence > 0 ? formatPence(pkg.setupPricePence, pkg.currency) : null,
    includes: includesLines(pkg.includes),
  }));
}

/**
 * The active packages of the single public organisation, cached for five
 * minutes. A price change in Settings → Packages reaches the public page
 * within that window without the page hitting Postgres on every visit.
 */
export const pricingPackages = unstable_cache(readPricingPackages, ["marketing-pricing-packages"], {
  revalidate: PRICING_REVALIDATE_SECONDS,
  tags: ["packages"],
});
