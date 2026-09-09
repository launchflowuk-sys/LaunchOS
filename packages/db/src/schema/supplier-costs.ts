import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { domains } from "./sites.js";

/**
 * What LaunchFlow pays a supplier, so a client's revenue can be read against
 * its cost.
 *
 * LaunchOS has always known what a client is **charged** — packages,
 * subscriptions, invoices, payments. It has never known what they **cost**, so
 * the Payments screen could show £950 of income against a client and say
 * nothing about whether that client was profitable. The registrar and the
 * hosting bill live in somebody else's dashboard, in another currency, under
 * product names rather than client names.
 *
 * This is the other half of the ledger. One row per supplier subscription,
 * synced read-only.
 */

export const supplierEnum = pgEnum("supplier", ["hostinger"]);

/**
 * How a cost came to be attached to a client, because the difference matters
 * when the figure looks wrong. A supplier's subscription is named after the
 * *product* (".LIVE Domain"), never the domain, so nothing can be matched with
 * certainty — only guessed at and then confirmed.
 */
export const costMatchEnum = pgEnum("cost_match", [
  /** Nobody has said who this belongs to. Counted in totals, attributed to no one. */
  "unassigned",
  /** The sync guessed from the TLD and the renewal date. Shown as a suggestion. */
  "suggested",
  /** A human said so. Never overwritten by a later sync. */
  "confirmed",
]);

export const supplierCosts = pgTable(
  "supplier_costs",
  {
    ...tenantColumns(),
    supplier: supplierEnum("supplier").notNull(),
    /** The supplier's own id for the subscription. Unique per organisation and supplier. */
    externalId: text("external_id").notNull(),
    /** Their words — ".LIVE Domain", "Starter Business Email". Never ours. */
    name: text("name").notNull(),
    /** Their status verbatim: `active`, `in_trial`, `cancelled`… */
    status: text("status").notNull(),
    /**
     * In the supplier's own currency and its minor unit — cents for USD. Not
     * converted on the way in: a stored figure that has already had a rate
     * applied cannot be re-read when the rate changes, and cannot be checked
     * against the supplier's invoice.
     */
    renewalPrice: integer("renewal_price").default(0).notNull(),
    /** What was paid to start it, which is often a discounted first term. */
    totalPrice: integer("total_price").default(0).notNull(),
    currencyCode: text("currency_code").default("USD").notNull(),
    billingPeriod: integer("billing_period").default(1).notNull(),
    billingPeriodUnit: text("billing_period_unit").default("year").notNull(),
    autoRenewed: boolean("auto_renewed").default(true).notNull(),
    /** When it next takes money. The whole point of the outgoings view. */
    nextBillingAt: timestamp("next_billing_at", { withTimezone: true }),
    /**
     * When the supplier started it, and the only field on the bill that says
     * what the line is *for*. Renewal dates do not work for this — a two-year
     * registration bills on a different cycle to when it expires — but the
     * purchase moment does, to the second.
     */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Set once somebody attributes the cost, or once the sync guesses. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** The domain it pays for, when it is a domain and we could tell which. */
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "set null" }),
    match: costMatchEnum("match").default("unassigned").notNull(),
    /** When the supplier last told us about it, so a vanished row is visible. */
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("supplier_costs_external").on(t.organisationId, t.supplier, t.externalId),
    index("supplier_costs_client").on(t.organisationId, t.clientId),
    index("supplier_costs_billing").on(t.organisationId, t.nextBillingAt),
  ],
);
