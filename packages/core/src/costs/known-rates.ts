import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { setUsageRate, type UsageProduct } from "./usage.js";

/**
 * Starting prices for the rate card.
 *
 * **Micro-pence per single unit** — millionths of a penny. A thousand tokens of
 * a frontier model is a fraction of a penny, so anything coarser rounds every
 * call to zero and the month comes out far too low.
 *
 * Converted from the providers' published dollar prices at roughly $1 = £0.79.
 * They are a **starting point, not gospel**: prices move, the FX rate moves,
 * and volume discounts exist. The reconciliation job's whole job is to compare
 * these against the real bill and flag the gap — a rate here being a little
 * wrong is the expected state, not a failure.
 *
 * Seeding is effective-dated from a long way back so historic usage prices
 * too, and `setUsageRate` never edits an existing row: a correction is a new
 * rate from today, which is what keeps a closed month stable.
 */

export interface KnownRate {
  supplier: (typeof schema.supplierEnum.enumValues)[number];
  product: UsageProduct;
  variant: string | null;
  microPencePerUnit: number;
  note: string;
}

/** Rates are seeded from here so historic usage is priced rather than left at zero. */
export const RATE_EPOCH = new Date(Date.UTC(2026, 0, 1));

export const KNOWN_RATES: readonly KnownRate[] = [
  // --- Anthropic. Per-token, from the per-million list prices. ---
  { supplier: "anthropic", product: "tokens_in", variant: "claude-opus-5", microPencePerUnit: 1_185, note: "$15/M in" },
  { supplier: "anthropic", product: "tokens_out", variant: "claude-opus-5", microPencePerUnit: 5_925, note: "$75/M out" },
  { supplier: "anthropic", product: "tokens_in", variant: "claude-sonnet-5", microPencePerUnit: 237, note: "$3/M in" },
  { supplier: "anthropic", product: "tokens_out", variant: "claude-sonnet-5", microPencePerUnit: 1_185, note: "$15/M out" },
  { supplier: "anthropic", product: "tokens_in", variant: "claude-haiku-4-5-20251001", microPencePerUnit: 79, note: "$1/M in" },
  { supplier: "anthropic", product: "tokens_out", variant: "claude-haiku-4-5-20251001", microPencePerUnit: 395, note: "$5/M out" },
  // Cache reads are a tenth of the input price; cache writes are a quarter more.
  { supplier: "anthropic", product: "tokens_in_cached", variant: null, microPencePerUnit: 119, note: "~10% of Opus input" },
  { supplier: "anthropic", product: "tokens_cache_write", variant: null, microPencePerUnit: 1_481, note: "~125% of Opus input" },
  // The catch-all. A model nobody has priced still costs something, and Opus is
  // the default in this codebase, so guessing low would understate.
  { supplier: "anthropic", product: "tokens_in", variant: null, microPencePerUnit: 1_185, note: "catch-all, Opus rate" },
  { supplier: "anthropic", product: "tokens_out", variant: null, microPencePerUnit: 5_925, note: "catch-all, Opus rate" },

  // --- OpenAI. The brief writer and the site generator. ---
  { supplier: "openai", product: "tokens_in", variant: "gpt-6-astra", microPencePerUnit: 198, note: "$2.50/M in" },
  { supplier: "openai", product: "tokens_out", variant: "gpt-6-astra", microPencePerUnit: 790, note: "$10/M out" },
  { supplier: "openai", product: "tokens_in", variant: null, microPencePerUnit: 198, note: "catch-all" },
  { supplier: "openai", product: "tokens_out", variant: null, microPencePerUnit: 790, note: "catch-all" },
  // Images, priced per image rather than per token.
  { supplier: "openai", product: "image", variant: "1024x1024", microPencePerUnit: 3_160_000, note: "$0.04 an image" },
  { supplier: "openai", product: "image", variant: "1536x1024", microPencePerUnit: 4_740_000, note: "$0.06 an image" },
  { supplier: "openai", product: "image", variant: null, microPencePerUnit: 3_160_000, note: "catch-all" },

  // --- The per-unit suppliers. ---
  { supplier: "postmark", product: "email", variant: null, microPencePerUnit: 100_000, note: "~0.1p an email on the 50k plan" },
  { supplier: "screenshotone", product: "screenshot", variant: null, microPencePerUnit: 200_000, note: "~0.2p a capture" },
  { supplier: "twilio", product: "message", variant: "sms", microPencePerUnit: 4_000_000, note: "~4p a UK SMS segment" },
  { supplier: "twilio", product: "message", variant: "whatsapp", microPencePerUnit: 3_500_000, note: "~3.5p a utility template" },
  { supplier: "twilio", product: "message", variant: null, microPencePerUnit: 4_000_000, note: "catch-all" },
];

/**
 * Seeds any rate that is not already on the card.
 *
 * Idempotent, matched on supplier, product and variant, so a rate somebody has
 * corrected is never overwritten — and running it after adding a new provider
 * only fills the gap.
 */
export async function prefillRates(db: Db, organisationId: string): Promise<{ added: number }> {
  const existing = await db
    .select({
      supplier: schema.usageRates.supplier,
      product: schema.usageRates.product,
      variant: schema.usageRates.variant,
    })
    .from(schema.usageRates)
    .where(eq(schema.usageRates.organisationId, organisationId));
  const have = new Set(existing.map((row) => `${row.supplier}::${row.product}::${row.variant ?? ""}`));

  let added = 0;
  for (const rate of KNOWN_RATES) {
    if (have.has(`${rate.supplier}::${rate.product}::${rate.variant ?? ""}`)) continue;
    await setUsageRate(db, organisationId, {
      supplier: rate.supplier,
      product: rate.product,
      variant: rate.variant,
      microPencePerUnit: rate.microPencePerUnit,
      effectiveFrom: RATE_EPOCH,
      note: rate.note,
    });
    added += 1;
  }
  return { added };
}

/** Every rate on the card, newest first per combination — what Settings → Costs lists. */
export async function listRates(db: Db, organisationId: string) {
  return db
    .select()
    .from(schema.usageRates)
    .where(and(eq(schema.usageRates.organisationId, organisationId)))
    .orderBy(schema.usageRates.supplier, schema.usageRates.product, schema.usageRates.variant);
}
