import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { servicesPaidFor } from "../clients/services.js";
import type { PackageOption } from "./pricing.js";

/**
 * Our sellable retainers, shaped for the funnel.
 *
 * Read from the `packages` table rather than written into the funnel, because
 * the list is going to grow — a new tier, LaunchOS sold on its own — and a
 * price that exists in two places disagrees with itself the first time one of
 * them moves. The table already holds the monthly figure, what the package
 * includes and the Stripe price it bills on, and it is the thing edited in
 * Settings → Packages.
 *
 * `covers` comes from `servicesPaidFor`, the same function the content planner
 * uses to decide what a package pays for — so the funnel's recommendation and
 * the work actually delivered cannot drift apart.
 *
 * Retainers only: a one-off or an add-on is not something to recommend as
 * somebody's monthly plan.
 */
export async function funnelPackageOptions(db: Db, organisationId: string): Promise<PackageOption[]> {
  const rows = await db
    .select({
      slug: schema.packages.slug,
      name: schema.packages.name,
      monthlyPricePence: schema.packages.monthlyPricePence,
      includes: schema.packages.includes,
    })
    .from(schema.packages)
    .where(and(
      eq(schema.packages.organisationId, organisationId),
      eq(schema.packages.active, true),
      eq(schema.packages.kind, "retainer"),
      isNull(schema.packages.deletedAt),
    ));

  return rows
    // A package with no price is half-configured, and recommending "£0 a
    // month" would be a promise nobody meant to make.
    .filter((row) => row.monthlyPricePence > 0)
    .map((row) => ({
      slug: row.slug,
      label: row.name,
      monthlyPence: row.monthlyPricePence,
      covers: [...servicesPaidFor(row.includes)],
    }))
    .sort((a, b) => a.monthlyPence - b.monthlyPence);
}
