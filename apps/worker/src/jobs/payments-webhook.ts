import { syncFromPaymentsEvent, type SyncResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { PaymentsWebhookEvent } from "@launchos/integrations";

export interface PaymentsWebhookJob {
  organisationId: string;
  providerEvent: PaymentsWebhookEvent;
}

export async function handlePaymentsWebhook(db: Db, job: PaymentsWebhookJob): Promise<SyncResult> {
  return syncFromPaymentsEvent(db, job.organisationId, job.providerEvent);
}
