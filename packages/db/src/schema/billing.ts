import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { documents } from "./documents.js";
import { packages } from "./packages.js";

// The entire "financial details" surface. No card numbers, no bank details:
// money movement is Stripe's job (Plan 5), and only its customer id lands here.
export const billingProfiles = pgTable(
  "billing_profiles",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    billingName: text("billing_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").default("GB").notNull(),
    vatNumber: text("vat_number"),
    paymentTermsDays: integer("payment_terms_days").default(14).notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    preferredMethod: text("preferred_method"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("billing_profiles_client").on(t.clientId),
    // A Stripe customer belongs to exactly one billing profile. The Stripe
    // webhook route resolves tenancy by looking this id up, so a second profile
    // carrying it would make that lookup ambiguous — and it would resolve
    // whichever row came back first, silently filing another organisation's
    // payment. NULL means "not linked to Stripe" and is left unconstrained, so
    // any number of profiles may have no customer id.
    uniqueIndex("billing_profiles_stripe_customer")
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),
  ],
);

/**
 * Every payment-provider customer a client pays LaunchFlow through. One person
 * can be a Cabio dispatch customer under one Stripe customer and pay for ad
 * management under another, or sign up twice with two emails — so a client
 * may carry several customer ids, and "one Stripe customer = one client" is
 * only true in the other direction. `billing_profiles.stripe_customer_id`
 * stays the primary (existing code reads it); the `is_primary` row here
 * mirrors it, and every lookup from a customer id to a client checks this
 * table first. The customer id is unique across every organisation, as the
 * webhook route resolves tenancy by it.
 */
export const clientPaymentAccounts = pgTable(
  "client_payment_accounts",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    provider: text("provider").default("stripe").notNull(),
    externalCustomerId: text("external_customer_id").notNull(),
    email: text("email"),
    name: text("name"),
    isPrimary: boolean("is_primary").default(false).notNull(),
  },
  (t) => [
    uniqueIndex("client_payment_accounts_provider_customer").on(t.provider, t.externalCustomerId),
    index("client_payment_accounts_org_client").on(t.organisationId, t.clientId),
  ],
);

export const subscriptionStatusEnum = pgEnum("subscription_status", ["trialing", "active", "past_due", "cancelled", "paused"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "sent", "paid", "overdue", "void"]);
export const paymentProviderEnum = pgEnum("payment_provider", ["stripe", "bank", "cash", "other"]);
export const paymentStatusEnum = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);

/** One invoice line as stored in invoices.line_items. */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPence: number;
}

export const subscriptions = pgTable("subscriptions", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** The Stripe Price the subscription is on, as last reported by the sync or a webhook. */
  stripePriceId: text("stripe_price_id"),
  status: subscriptionStatusEnum("status").default("active").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  amountPence: integer("amount_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
}, (t) => [uniqueIndex("subscriptions_org_stripe_id").on(t.organisationId, t.stripeSubscriptionId)]);

export const invoices = pgTable("invoices", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  number: text("number").notNull(),
  status: invoiceStatusEnum("status").default("draft").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  subtotalPence: integer("subtotal_pence").notNull(),
  vatPence: integer("vat_pence").default(0).notNull(),
  totalPence: integer("total_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
  stripeInvoiceId: text("stripe_invoice_id"),
  pdfUrl: text("pdf_url"),
  /**
   * The invoice as a PDF on LaunchFlow's headed paper, rendered on send and
   * kept. `pdf_url` above is Stripe's own hosted copy for an invoice Stripe
   * raised; this is ours, read through the same signed link every other
   * document uses. A real column rather than only `documents.subject_id`
   * because the invoice is the owning row and one lookup should answer "where
   * is its PDF", exactly as `proposals.document_id` does.
   */
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  lineItems: jsonb("line_items").$type<InvoiceLineItem[]>().default([]).notNull(),
}, (t) => [
  uniqueIndex("invoices_org_number").on(t.organisationId, t.number),
  uniqueIndex("invoices_org_stripe_id").on(t.organisationId, t.stripeInvoiceId),
]);

/**
 * Per-organisation, per-year invoice counter. Numbers are allocated with a
 * single upserting statement so two concurrent invoices can never collide.
 */
export const invoiceSequences = pgTable("invoice_sequences", {
  ...tenantColumns(),
  year: integer("year").notNull(),
  nextNumber: integer("next_number").default(0).notNull(),
}, (t) => [uniqueIndex("invoice_sequences_org_year").on(t.organisationId, t.year)]);

export const payments = pgTable("payments", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  amountPence: integer("amount_pence").notNull(),
  currency: text("currency").default("GBP").notNull(),
  provider: paymentProviderEnum("provider").default("other").notNull(),
  providerRef: text("provider_ref"),
  status: paymentStatusEnum("status").default("pending").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [uniqueIndex("payments_org_provider_ref").on(t.organisationId, t.provider, t.providerRef)]);
