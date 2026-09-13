import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { costBusinessEnum, supplierEnum } from "./supplier-costs.js";

/**
 * The variable half of the cost register: every paid call, as it happens.
 *
 * The register knows what a subscription costs. It cannot know that generating
 * one website burned 90,000 OpenAI tokens, or that a client with the blog
 * service on costs four image generations a month more than one without. That
 * is what this is for — the per-client cost that moves.
 *
 * **Priced at write time, from the rate card in force on that day.** The
 * alternative is pricing at read time, which means every past month's cost
 * changes the moment a provider puts its prices up. `cost_pence` is a stored
 * fact, and `rate_id` says which rate produced it, so a wrong price can be
 * traced rather than guessed at.
 *
 * `client_id` is nullable on purpose: a site generation belongs to a client, a
 * nightly ops brief belongs to nobody. Unattributed usage is still company
 * cost and still counted.
 */

/** What was consumed. Not the supplier — `supplier` says that. */
export const usageProductEnum = pgEnum("usage_product", [
  /** LLM tokens, in. Cache reads and writes are separate products: they are priced differently. */
  "tokens_in",
  "tokens_in_cached",
  "tokens_cache_write",
  "tokens_out",
  /** One generated image, priced by size through the rate card's `variant`. */
  "image",
  /** One website screenshot. */
  "screenshot",
  /** One email accepted by the provider. */
  "email",
  /** One SMS or WhatsApp message segment. */
  "message",
  /**
   * A payment processor's cut on one transaction.
   *
   * Unlike everything else here it is not a call we make — it is deducted from
   * money coming in — so it arrives through a sync rather than at the moment
   * it happens. It belongs in the ledger all the same: it is a per-transaction
   * variable cost, which is exactly what this table is for.
   */
  "fee",
]);

/** What produced the usage, so a figure on a screen can be traced to the thing that spent it. */
export const usageSourceEnum = pgEnum("usage_source", [
  "agent_run",
  "brief_writer",
  "site_build",
  "content_draft",
  "image_render",
  "screenshot",
  "email_send",
  "message_send",
  /** A processor fee, read back off the provider's own ledger. */
  "processor_fee",
  "other",
]);

export const usageEvents = pgTable(
  "usage_events",
  {
    ...tenantColumns(),
    /** Null for company-wide work — a nightly brief belongs to no client. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Which business carries it. Defaults per supplier and is correctable. */
    business: costBusinessEnum("business").default("launchflow").notNull(),
    supplier: supplierEnum("supplier").notNull(),
    product: usageProductEnum("product").notNull(),
    /** The model, image size, or message channel — whatever the rate card keys on. */
    variant: text("variant"),
    /**
     * How many. Tokens run to millions, so bigint rather than integer: a
     * 2.1-billion-token month is not far-fetched across a year of agent runs
     * and `integer` would silently overflow.
     */
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    unit: text("unit").default("token").notNull(),
    /**
     * Cost in **GBP pence at write time**, already converted. Stored rather
     * than derived so a past month cannot move when a rate or an FX rate
     * changes — the same reason `fx_rates` exists.
     */
    costPence: integer("cost_pence").default(0).notNull(),
    /** The rate that produced `cost_pence`. Null when nothing matched, which is visible rather than free. */
    rateId: uuid("rate_id"),
    source: usageSourceEnum("source").default("other").notNull(),
    /** The run, build or message this came from, so a figure can be opened. */
    sourceId: uuid("source_id"),
    /**
     * When it was consumed, not when it was recorded. A retried job writes the
     * moment of the call, so a month's total does not move because a queue was
     * slow.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * One write per thing. A job that retries after committing must not double
     * the month's cost, and pg-boss retries are normal rather than rare.
     */
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    uniqueIndex("usage_events_idempotent").on(t.organisationId, t.idempotencyKey),
    index("usage_events_month").on(t.organisationId, t.occurredAt),
    index("usage_events_client").on(t.organisationId, t.clientId, t.occurredAt),
    index("usage_events_business").on(t.organisationId, t.business, t.occurredAt),
  ],
);

/**
 * What a unit costs, and from when.
 *
 * Effective-dated rather than a single current price, because a provider
 * raising its prices must not rewrite what last quarter cost. A usage event
 * takes the rate in force on the day it happened, for ever.
 *
 * Prices are held in **micro-pence per unit** — millionths of a penny. A
 * thousand input tokens of Opus is fractions of a penny; anything coarser
 * rounds every small call to zero and the month's total comes out far too low.
 */
export const usageRates = pgTable(
  "usage_rates",
  {
    ...tenantColumns(),
    supplier: supplierEnum("supplier").notNull(),
    product: usageProductEnum("product").notNull(),
    /** The model or size this rate is for. Null is the catch-all for that supplier and product. */
    variant: text("variant"),
    /** Micro-pence per single unit. 1,000,000 = one penny per unit. */
    microPencePerUnit: bigint("micro_pence_per_unit", { mode: "number" }).notNull(),
    /** Inclusive. A rate applies from this day until the next one supersedes it. */
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
    /** Where the number came from — a price page, an invoice — so it can be checked. */
    note: text("note"),
  },
  (t) => [
    index("usage_rates_lookup").on(t.organisationId, t.supplier, t.product, t.variant, t.effectiveFrom),
  ],
);
