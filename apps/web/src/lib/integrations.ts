import { createPaymentsAdapter, type PaymentsAdapter } from "@launchos/integrations";

/**
 * The payments adapter, created on first use and cached for the process.
 *
 * Cached rather than built per call for the same reason `getDb` is: the mock
 * adapter keeps its customers, subscriptions and its id counter in memory, so a
 * fresh instance per server action would hand out `mock_sub_1` every time and
 * collide with the unique index on (organisation_id, stripe_subscription_id).
 * `globalThis` survives the module re-evaluation `next dev` does on every edit;
 * production never recompiles and keeps the plain module-scope cache.
 *
 * Server-side only — importing this from a client component would pull the
 * Stripe SDK into the browser bundle.
 */
const globalForPayments = globalThis as typeof globalThis & { __launchosPayments?: PaymentsAdapter };

let cached: PaymentsAdapter | undefined;

export function getPayments(): PaymentsAdapter {
  const existing = cached ?? (process.env.NODE_ENV === "production" ? undefined : globalForPayments.__launchosPayments);
  if (existing) {
    cached = existing;
    return existing;
  }
  cached = createPaymentsAdapter(process.env);
  if (process.env.NODE_ENV !== "production") globalForPayments.__launchosPayments = cached;
  return cached;
}
