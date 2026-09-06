import { syncFromPaymentsEvent, type SyncDeps, type SyncResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { PaymentsWebhookEvent } from "@launchos/integrations";

export interface PaymentsWebhookJob {
  organisationId: string;
  providerEvent: PaymentsWebhookEvent;
}

/**
 * `deps.payments` lets a `customer.subscription.*` event for a customer
 * LaunchOS has never seen be provisioned with the customer's real email and
 * name (one `retrieveCustomer` call) rather than from the `cus_` id alone.
 */
export async function handlePaymentsWebhook(db: Db, job: PaymentsWebhookJob, deps: SyncDeps = {}): Promise<SyncResult> {
  return syncFromPaymentsEvent(db, job.organisationId, job.providerEvent, process.env, deps);
}
