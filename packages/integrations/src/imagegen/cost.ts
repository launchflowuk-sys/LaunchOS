import type { ImageGenSize } from "./types.js";

/**
 * What one image costs, per provider and size, in whole pence.
 *
 * **Every number here is an estimate, not a billed figure.** No provider tells
 * us what a request cost in the response, so the adapters report from this
 * table and `renderContentImage` sums it against `IMAGEGEN_MONTHLY_CAP_PENCE`.
 * Reconciling to a provider invoice is not the job — noticing that this month
 * has drawn forty pictures instead of four is.
 *
 * Two rules run through the table:
 *
 * 1. **Round up, never down.** `costPence` is a whole number and it is what the
 *    cap counts, so an estimate that under-reports lets the cap overrun. A
 *    penny of pessimism per image is the cheapest safety there is.
 * 2. **Re-check the numbers when a model changes.** Both providers publish
 *    per-image and per-megapixel prices that move; the constants below were
 *    taken from their pricing pages in September 2026 and converted at roughly
 *    $1.27 to the pound.
 */

/**
 * OpenAI bills `gpt-image-1` by image tokens, but publishes the resulting
 * per-image figures. At the default quality (`medium`, which is what the
 * adapter asks for by not asking for anything else) those are about $0.042 for
 * a square and $0.063 for either rectangle — 3.3p and 5.0p, rounded up here.
 *
 * `quality: "high"` is roughly four times this. The adapter deliberately does
 * not offer it: a social post is looked at on a phone, and four times the
 * spend for detail nobody sees would eat the monthly cap in a fortnight.
 */
export const OPENAI_IMAGE_COST_PENCE: Record<ImageGenSize, number> = {
  "1024x1024": 4,
  "1024x1536": 6,
  "1536x1024": 6,
};

/**
 * fal.ai bills `flux/schnell` at about $0.003 per megapixel: 1.05 MP for the
 * square (0.25p) and 1.57 MP for either rectangle (0.37p). Both are well under
 * a penny, so every size sits on the 1p floor — an image that rounds to zero
 * would make the cap count nothing at all, which is worse than over-charging
 * ourselves by three quarters of a penny.
 */
export const FAL_IMAGE_COST_PENCE: Record<ImageGenSize, number> = {
  "1024x1024": 1,
  "1024x1536": 1,
  "1536x1024": 1,
};
