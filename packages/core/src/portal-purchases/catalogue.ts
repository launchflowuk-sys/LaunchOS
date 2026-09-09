import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes, PackageKind } from "@launchos/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

/**
 * What a client is allowed to buy from their own portal, and what they are
 * already paying for.
 *
 * Three conditions, all required, and the third is the one that matters:
 * `active` (we still sell it), `self_serve` (somebody deliberately opened it
 * to clients), and a Stripe price (there is something to charge against). A
 * package missing any of them is invisible here rather than buyable-but-broken
 * — a half-configured offering that reaches Checkout fails in front of a
 * paying customer, which is the worst place to find out.
 *
 * `self_serve` defaults to false precisely so that adding this feature sold
 * nothing by accident: every package that existed before it stays closed until
 * it is switched on.
 */

export interface Offering {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: PackageKind;
  monthlyPricePence: number;
  setupPricePence: number;
  currency: string;
  trialDays: number;
  includes: PackageIncludes;
  /** Never null in practice — the catalogue filters on `is not null`. */
  stripePriceId: string | null;
}

export interface PortalCatalogue {
  offerings: Offering[];
  /**
   * The retainers this client is already on. Empty for most of them; the
   * services screen uses it to warn before adding a second monthly charge.
   */
  liveRetainers: { subscriptionId: string; packageId: string | null; name: string | null; amountPence: number }[];
}

export async function listPortalCatalogue(
  db: Db,
  organisationId: string,
  clientId: string,
): Promise<PortalCatalogue> {
  const [offerings, liveRetainers] = await Promise.all([
    db
      .select({
        id: schema.packages.id,
        name: schema.packages.name,
        slug: schema.packages.slug,
        description: schema.packages.description,
        kind: schema.packages.kind,
        monthlyPricePence: schema.packages.monthlyPricePence,
        setupPricePence: schema.packages.setupPricePence,
        currency: schema.packages.currency,
        trialDays: schema.packages.trialDays,
        includes: schema.packages.includes,
        stripePriceId: schema.packages.stripePriceId,
      })
      .from(schema.packages)
      .where(and(
        eq(schema.packages.organisationId, organisationId),
        eq(schema.packages.active, true),
        eq(schema.packages.selfServe, true),
        isNotNull(schema.packages.stripePriceId),
      ))
      .orderBy(schema.packages.monthlyPricePence, schema.packages.name),
    db
      .select({
        subscriptionId: schema.subscriptions.id,
        packageId: schema.subscriptions.packageId,
        name: schema.packages.name,
        amountPence: schema.subscriptions.amountPence,
      })
      .from(schema.subscriptions)
      .leftJoin(schema.packages, eq(schema.subscriptions.packageId, schema.packages.id))
      .where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.clientId, clientId),
        eq(schema.subscriptions.status, "active"),
      )),
  ]);

  return { offerings, liveRetainers };
}

/** One offering by slug, subject to exactly the same three conditions. */
export async function getOffering(
  db: Db,
  organisationId: string,
  slug: string,
): Promise<Offering | null> {
  const [row] = await db
    .select({
      id: schema.packages.id,
      name: schema.packages.name,
      slug: schema.packages.slug,
      description: schema.packages.description,
      kind: schema.packages.kind,
      monthlyPricePence: schema.packages.monthlyPricePence,
      setupPricePence: schema.packages.setupPricePence,
      currency: schema.packages.currency,
      trialDays: schema.packages.trialDays,
      includes: schema.packages.includes,
      stripePriceId: schema.packages.stripePriceId,
    })
    .from(schema.packages)
    .where(and(
      eq(schema.packages.organisationId, organisationId),
      eq(schema.packages.slug, slug),
      eq(schema.packages.active, true),
      eq(schema.packages.selfServe, true),
      isNotNull(schema.packages.stripePriceId),
    ));
  return row ?? null;
}

/** What this offering costs today, in pence — the figure written onto the purchase. */
export function priceOf(offering: Offering): number {
  return offering.kind === "retainer"
    ? offering.monthlyPricePence + offering.setupPricePence
    : offering.setupPricePence || offering.monthlyPricePence;
}
