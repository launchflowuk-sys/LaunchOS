import { index, integer, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { packages } from "./packages.js";
import { subscriptions } from "./billing.js";

/**
 * What a monthly charge is actually made of.
 *
 * `subscriptions.amount_pence` is one number because it was written for
 * Stripe, where one subscription is one price. Real arrangements are not
 * shaped like that. AMO Rendering pays £200 a month — two websites at £45 and
 * ad management at £110 — as a single bank transfer, and LaunchOS showed
 * "£99.00 active" because there was nowhere to put the parts. Neither the
 * figure nor the story behind it was right.
 *
 * A line per thing charged. `amount_pence` on the subscription stays as the
 * total so every existing reader keeps working, and becomes the sum of these
 * once a subscription has any.
 */

/**
 * How the money actually arrives.
 *
 * Stripe was the only answer the product had, and most of these clients pay by
 * bank transfer on an invoice. The method decides what LaunchOS should *do*
 * each period: `stripe` collects itself and needs nothing; everything else
 * needs an invoice raising and a payment recording by hand, which is the work
 * this column makes visible.
 */
export const collectionMethodEnum = pgEnum("collection_method", [
  /** Stripe takes it. Nothing to do each month. */
  "stripe",
  /** They pay the invoice by transfer. The common case here. */
  "bank_transfer",
  /** A standing order they control — the money arrives whether an invoice does or not. */
  "standing_order",
  /** A mandate we control. Not wired to a provider yet; recorded so the plan is visible. */
  "direct_debit",
  "cash",
  "other",
]);

export const subscriptionLines = pgTable(
  "subscription_lines",
  {
    ...tenantColumns(),
    subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
    /** What the client sees on the invoice: "Website care — thurrockexpresstaxis.co.uk". */
    description: text("description").notNull(),
    /** Two websites at £45 is one line with a quantity, not two lines. */
    quantity: integer("quantity").default(1).notNull(),
    /** Per unit, in pence. The line total is quantity × this. */
    unitAmountPence: integer("unit_amount_pence").default(0).notNull(),
    /**
     * The package this line represents, when it is one. Optional: "ad
     * management at £110" is a real line whether or not a package exists for
     * it, and forcing one would mean inventing packages to describe history.
     */
    packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
    /** Ordering on the invoice and on screen. */
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [index("subscription_lines_subscription").on(t.subscriptionId, t.sort)],
);
