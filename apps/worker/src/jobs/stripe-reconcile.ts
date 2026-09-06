import { reconcileStripe, type StripeSyncSummary } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { PaymentsAdapter } from "@launchos/integrations";

/**
 * 04:10 London, daily: after Stripe's own overnight billing runs (which move
 * subscriptions to `past_due` or `canceled` around midnight UTC) and well
 * before the 06:00 task sweeps read a client's package.
 */
export const STRIPE_RECONCILE_CRON = "10 4 * * *";

export interface StripeReconcileLogger {
  info(...args: unknown[]): void;
}

export type StripeReconcileResult =
  | { skipped: "not_stripe"; adapter: PaymentsAdapter["name"] }
  | { skipped?: undefined; summary: StripeSyncSummary };

/**
 * Re-applies the owner's stored product selection against Stripe for one
 * organisation. Nothing to reconcile against on the mock adapter: its
 * catalogue is whatever a test seeded, so the run is logged and skipped
 * rather than left to import an empty catalogue every night.
 */
export async function runStripeReconcile(
  db: Db,
  organisationId: string,
  payments: PaymentsAdapter,
  logger: StripeReconcileLogger = console,
): Promise<StripeReconcileResult> {
  if (payments.name !== "stripe") {
    logger.info({ org: organisationId, adapter: payments.name }, "stripe reconcile skipped: payments adapter is not Stripe");
    return { skipped: "not_stripe", adapter: payments.name };
  }
  const summary = await reconcileStripe(db, organisationId, payments);
  logger.info({
    org: organisationId,
    clientsCreated: summary.clients.created.length,
    subscriptions: summary.subscriptions,
    statusChanges: summary.statusChanges.length,
  }, "stripe reconcile");
  return { summary };
}
