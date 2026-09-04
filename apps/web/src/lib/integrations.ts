import { createPaymentsAdapter, type PaymentsAdapter } from "@launchos/integrations";
import { vatRateFromEnv } from "./env";

/**
 * The payments adapter, created on first use and cached for the process.
 *
 * Cached rather than built per call for the same reason `getDb` is: the mock
 * adapter keeps the customers, subscriptions and invoices it has issued in
 * memory, and a fresh instance per server action would forget all of them.
 * `globalThis` survives the module re-evaluation `next dev` does on every edit;
 * production never recompiles and keeps the plain module-scope cache. (Mock ids
 * are UUID-based, so a lost cache no longer risks a collision — see
 * `MockPaymentsAdapter`.)
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
  // VAT comes from the validated env module, so a blank `VAT_RATE` is a startup
  // error rather than a silent 0%.
  cached = createPaymentsAdapter({ ...process.env, VAT_RATE: String(vatRateFromEnv()) });
  if (process.env.NODE_ENV !== "production") globalForPayments.__launchosPayments = cached;
  return cached;
}
