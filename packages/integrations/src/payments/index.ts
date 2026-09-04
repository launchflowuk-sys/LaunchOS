import { MockPaymentsAdapter } from "./mock.js";
import { StripePaymentsAdapter } from "./stripe.js";
import type { PaymentsAdapter } from "./types.js";

export * from "./types.js";
export { MockPaymentsAdapter } from "./mock.js";
export { StripePaymentsAdapter } from "./stripe.js";

/** UK standard rate, used whenever `VAT_RATE` is unset or unusable. */
export const DEFAULT_VAT_RATE_PERCENT = 20;

/**
 * VAT rate as a whole-number percentage; UK standard rate when unset.
 *
 * The trim matters: `Number("")` and `Number(" ")` are `0`, which is finite and
 * non-negative, so a `VAT_RATE=` line left blank used to mean 0% VAT on every
 * invoice rather than the fallback. Blank is treated as unset here; callers
 * that want a blank value to be a loud failure validate it first (see
 * `apps/web/src/lib/env.ts` and `apps/worker/src/env.ts`).
 */
export function vatRateFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.VAT_RATE?.trim();
  if (!raw) return DEFAULT_VAT_RATE_PERCENT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_VAT_RATE_PERCENT;
}

/**
 * Stripe only when it is fully configured. A half-set Stripe environment falls
 * back to the mock rather than failing at boot, so a missing key can never take
 * the whole app down — the adapter in use is shown in Settings → Billing.
 */
export function createPaymentsAdapter(env: NodeJS.ProcessEnv): PaymentsAdapter {
  const termsDays = Number(env.PAYMENT_TERMS_DAYS) || 14;
  if (env.PAYMENTS_ADAPTER === "stripe" && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    return new StripePaymentsAdapter({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      termsDays,
    });
  }
  return new MockPaymentsAdapter({ vatRatePercent: vatRateFromEnv(env), termsDays });
}
