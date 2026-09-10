import {
  createInvoiceFromSubscription,
  notifyOwner,
  requestInvoiceSendOnce,
  subscriptionsDueToInvoice,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { sweep, throwOnSweepFailure } from "./sweep.js";

/**
 * Raising the month's invoices for everybody Stripe does not collect from.
 *
 * Nothing did this. Invoices came from signup or from somebody pressing "Raise
 * invoice" on a client screen, so a client billed by transfer got theirs when
 * Shoji remembered — and it carried whatever date that happened to be. One
 * raised on 5 September for a period starting 5 September came out due
 * 5 October, a month after the client should have paid.
 *
 * The invoice is raised at the client's own notice date and the send is queued
 * as an approval, not posted. Money leaving on a wrong figure is the one thing
 * here that cannot be taken back, and the approvals queue is where every other
 * outward action already waits.
 */

export interface RaiseDueDeps {
  db: Db;
  logger?: Pick<Console, "info" | "error"> | undefined;
}

export interface RaiseDueResult {
  /** Retainers whose notice date has arrived and had no invoice yet. */
  due: number;
  raised: number;
  /** Sends queued for a human decision. */
  queued: number;
  failed: number;
}

export async function runRaiseDueInvoices(
  deps: RaiseDueDeps,
  organisationId: string,
  now: Date = new Date(),
): Promise<RaiseDueResult> {
  const logger = deps.logger ?? console;
  const due = await subscriptionsDueToInvoice(deps.db, organisationId, now);

  let raised = 0;
  let queued = 0;
  const label = `billing raise-due (${organisationId})`;

  const summary = await sweep(due, { label, id: (row) => row.subscriptionId, logger }, async (row) => {
    const invoice = await createInvoiceFromSubscription(deps.db, organisationId, {
      subscriptionId: row.subscriptionId,
      actorKind: "system",
    });
    raised += 1;

    // Queued, never sent. `requestInvoiceSendOnce` is idempotent, so a retry of
    // this job files no second card for the same invoice.
    // `actorId` is who the approval says asked for it. The sweep is the
    // system, and naming it as such keeps a scheduled raise distinguishable
    // from Shoji pressing the button.
    await requestInvoiceSendOnce(deps.db, organisationId, {
      invoiceId: invoice.id,
      actorId: "system:billing.raise-due",
    });
    queued += 1;
  });

  if (raised > 0) {
    await notifyOwner(deps.db, organisationId, {
      kind: "invoice.raised",
      title: `${raised} invoice${raised === 1 ? "" : "s"} ready to send`,
      body: due
        .map((row) => `${row.clientName}: £${(row.amountPence / 100).toFixed(2)} due ${row.dates.dueAt.toISOString().slice(0, 10)}`)
        .join(". "),
      link: "/approvals",
    });
  }

  const result: RaiseDueResult = { due: due.length, raised, queued, failed: summary.failed };
  logger.info({ organisationId, ...result }, "billing raise-due");
  throwOnSweepFailure(label, summary);
  return result;
}
