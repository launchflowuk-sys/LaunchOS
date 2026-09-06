import { buildDeliveryReport, type DeliveryReport, projectUpdateRecipients } from "@launchos/core";
import type { QueuePolicy } from "@launchos/core/queue";
import { getDb } from "@/lib/db";
import { sendUnlistedJob } from "@/lib/queue";

/**
 * Sending a handover, from a process that cannot print one.
 *
 * `sendDeliveryReport` renders the PDF with Playwright's Chromium, and
 * `playwright` is a dependency of `apps/worker`, deliberately not of this app
 * — a send from a Server Action would work on a laptop and fail on Coolify.
 * So the web queues the work and the worker does it, exactly as
 * `proposals/send-queue.ts` does for a proposal. A render, a file write and an
 * email have no business inside the request that pressed the button.
 *
 * **The queue name is declared here rather than in core, and that is
 * temporary.** P5-core landed `renderDeliveryReport`, `sendDeliveryReport` and
 * `countersignDeliveryReport` and left the queue table to P5-worker, which is
 * being written in parallel. The choice was: cast a string to `QueueName`,
 * launch a browser from a Server Action, or say plainly what queue this send
 * needs and create it. The third is the only one of those that is both honest
 * and safe. When `packages/core/src/queue/queues.ts` names it, delete
 * `DELIVERY_SEND_QUEUE` and `sendUnlistedJob` and go back through `sendJob`.
 */

/** What the worker's handover job should be called. See the note above. */
export const DELIVERY_SEND_QUEUE = "delivery.send";

/**
 * `short`, because every send to it carries a key — the same rule every other
 * fully-keyed queue in `QUEUE_POLICY` follows. A duplicate is collapsed while
 * the first job is still queued; a second send once the first has run is
 * legitimate (a client who lost the email needs another one) and is core's to
 * allow, which it does.
 */
export const DELIVERY_SEND_POLICY: QueuePolicy = "short";

/** Ids only: the worker reads the rows itself, as it does for a proposal send. */
export interface DeliverySendJob {
  organisationId: string;
  projectId: string;
  /** Who pressed the button, so the audit trail names a person rather than the worker. */
  actorId?: string;
}

/**
 * Everything a handover send cannot survive, checked before the job is queued.
 *
 * Core refuses these itself and would refuse them again in the worker — but
 * there the refusal is a log line nobody reads, and the person who pressed
 * Send has been told it was on its way. Pure, so the page can print the same
 * sentence above a disabled button that the action would have answered with.
 */
export function whyHandoverRefused(report: DeliveryReport, recipients: readonly string[]): string | null {
  if (report.project.status === "cancelled") {
    return `${report.project.name} was cancelled, so there is nothing to hand over.`;
  }
  if (report.signOff) {
    return `${report.project.name} was signed off by ${report.signOff.signedName} — its report is evidence now and cannot be re-rendered.`;
  }
  if (recipients.length === 0) {
    return "Nobody on this client has an email address, so there is nowhere to send the handover. Add a portal user or an address on the client first.";
  }
  return null;
}

export type SendQueueResult = { ok: true } | { ok: false; message: string };

/**
 * Queues one handover send.
 *
 * Keyed on the project, so a double press is one job while the first is still
 * queued; core's own `not_signable` refusal is what stops a send once the
 * client has signed.
 */
export async function queueDeliverySend(organisationId: string, projectId: string, actorId: string): Promise<SendQueueResult> {
  const db = getDb();
  const report = await buildDeliveryReport(db, organisationId, { projectId });
  const recipients = await projectUpdateRecipients(db, organisationId, report.project.clientId);
  const refused = whyHandoverRefused(report, recipients);
  if (refused) return { ok: false, message: refused };

  const job: DeliverySendJob = { organisationId, projectId, actorId };
  await sendUnlistedJob(DELIVERY_SEND_QUEUE, DELIVERY_SEND_POLICY, job, { singletonKey: `delivery-send:${projectId}` });
  return { ok: true };
}
