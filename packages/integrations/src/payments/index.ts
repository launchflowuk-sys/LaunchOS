import { MockPaymentsAdapter } from "./mock.js";
import { StripePaymentsAdapter } from "./stripe.js";
import type { PaymentsAdapter } from "./types.js";

export * from "./types.js";
export { MockPaymentsAdapter } from "./mock.js";
export { StripePaymentsAdapter } from "./stripe.js";

/** VAT rate as a whole-number percentage; UK standard rate when unset. */
export function vatRateFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.VAT_RATE);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
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
