import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { packages } from "./packages.js";
import { projects } from "./projects.js";

/**
 * A client buying something from their own portal.
 *
 * The row is written *before* Stripe is opened, not after the money lands.
 * Three things follow from that and they are the reason this table exists at
 * all rather than the flow leaning on Stripe's session alone:
 *
 *  - `stripe_session_id` is unique, so the return trip and the webhook can both
 *    try to complete the same purchase and only one of them wins. Without it a
 *    client who refreshes the success page gets two projects.
 *  - a purchase that never completes stays `pending`, which is the only way to
 *    see an abandoned checkout at all.
 *  - what they agreed to is recorded at the moment they agreed, so a price
 *    edited afterwards cannot rewrite what was sold.
 */

export const portalPurchaseStatusEnum = pgEnum("portal_purchase_status", [
  /** Written; Stripe not yet answered. */
  "pending",
  /** Paid outright. */
  "paid",
  /** On a free trial — counts as confirmed, and onboarding starts. */
  "trialing",
  /** Stripe said no, or the session expired. */
  "failed",
  /** Abandoned or cancelled before completing. */
  "cancelled",
]);

export const portalPurchases = pgTable(
  "portal_purchases",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    /**
     * Who clicked buy. A client can have several people in their portal and
     * "who ordered this" is the first question asked when one of them queries
     * the charge.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** `on delete restrict` in spirit: a package that has been sold is history, not config. */
    packageId: uuid("package_id").notNull().references(() => packages.id),
    status: portalPurchaseStatusEnum("status").default("pending").notNull(),
    /** Unique, and the whole idempotency story. */
    stripeSessionId: text("stripe_session_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeCustomerId: text("stripe_customer_id"),
    /** What it cost at the moment of sale, in pence — never re-read from the package. */
    amountPence: integer("amount_pence").default(0).notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** Free-trial length as sold, so changing the package later cannot alter it. */
    trialDays: integer("trial_days").default(0).notNull(),
    /** The project the purchase created, once it has one. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** When the money (or the trial) was confirmed. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("portal_purchases_session").on(t.stripeSessionId),
    index("portal_purchases_client_time").on(t.clientId, t.createdAt),
  ],
);
