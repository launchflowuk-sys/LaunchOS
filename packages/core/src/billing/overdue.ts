import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicketInTx } from "../support/create-ticket.js";
import { HOLDING_CLIENT_SLUG } from "../support/ingest-inbound-email.js";

export const FindOverdueInvoicesInput = z.object({ now: z.date().default(() => new Date()) });
export type FindOverdueInvoicesInput = z.input<typeof FindOverdueInvoicesInput>;

export interface OverdueOutcome {
  invoice: typeof schema.invoices.$inferSelect;
  ticketId: string;
}

/**
 * Flips every sent invoice whose due date has passed to `overdue`, raises one
 * billing ticket per invoice and notifies the owner once.
 *
 * Each invoice is isolated in its own transaction that (a) atomically claims
 * the invoice with `UPDATE ... WHERE status = 'sent' RETURNING` — the claim
 * is the transaction's first write, so two overlapping sweeps can each claim
 * a given invoice at most once: whichever commits first moves the row off
 * `sent`, and the other sees no row to update and skips it; (b) raises the
 * ticket via `createTicketInTx` on the same `tx`; (c) stamps
 * `metadata.overdueTicketId`; (d) audits. `ticket.created` is emitted and the
 * owner notified only after that transaction commits — never a partial
 * state. A crash between "ticket raised" and "invoice flipped" is therefore
 * impossible: either the whole transaction lands or none of it does, and a
 * retried sweep finds the invoice still `sent` with no stray ticket behind
 * it.
 *
 * One invoice's failure — a data problem, a transient error — is caught and
 * skipped rather than aborting the rest of the sweep. Every failure is
 * collected and re-thrown together as an `AggregateError` once every invoice
 * has been attempted, so a caller still finds out something went wrong
 * without the whole run being lost to the first bad invoice.
 *
 * Invoices billed to the `unmatched` holding client (unrouted inbound mail,
 * never a real billing relationship) are skipped — there is no one to chase.
 */
export async function findOverdueInvoices(
  db: Db,
  organisationId: string,
  input: FindOverdueInvoicesInput,
): Promise<OverdueOutcome[]> {
  const v = FindOverdueInvoicesInput.parse(input);
  const due = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.organisationId, organisationId),
    eq(schema.invoices.status, "sent"),
    lt(schema.invoices.dueAt, v.now),
  ));

  const outcomes: OverdueOutcome[] = [];
  const errors: unknown[] = [];

  for (const invoice of due) {
    try {
      const [client] = await db.select({ name: schema.clients.name, slug: schema.clients.slug })
        .from(schema.clients).where(eq(schema.clients.id, invoice.clientId));
      if (client?.slug === HOLDING_CLIENT_SLUG) continue;

      const amount = `£${(invoice.totalPence / 100).toFixed(2)}`;
      const dueOn = invoice.dueAt.toISOString().slice(0, 10);

      const claim = await db.transaction(async (tx) => {
        const [claimed] = await tx.update(schema.invoices)
          .set({ status: "overdue", updatedAt: new Date() })
          .where(and(
            eq(schema.invoices.id, invoice.id),
            eq(schema.invoices.organisationId, organisationId),
            eq(schema.invoices.status, "sent"),
          ))
          .returning();
        if (!claimed) return undefined; // already claimed by another sweep

        const { ticket } = await createTicketInTx(tx as unknown as Db, organisationId, {
          clientId: invoice.clientId,
          subject: `Invoice ${invoice.number} is overdue`,
          body: `Invoice ${invoice.number} for ${amount} was due on ${dueOn} and is still unpaid. Chase ${client?.name ?? "the client"} and record the payment once it lands.`,
          severity: "high",
          category: "billing",
          source: "monitor",
          actorKind: "system",
        });

        const [after] = await tx.update(schema.invoices)
          .set({ metadata: { ...claimed.metadata, overdueTicketId: ticket.id }, updatedAt: new Date() })
          .where(eq(schema.invoices.id, invoice.id))
          .returning();
        await recordAudit(tx as unknown as Db, organisationId, {
          actorKind: "system", action: "invoice.overdue",
          targetType: "invoice", targetId: invoice.id, before: invoice, after,
        });
        return { invoice: after!, ticketId: ticket.id };
      });

      if (!claim) continue;

      // Emitted and notified only once the transaction is durable.
      // `createTicketInTx`'s own contract requires the caller to emit
      // `ticket.created` itself, after its own commit — see create-ticket.ts.
      await emit({ name: "ticket.created", organisationId, ticketId: claim.ticketId });
      await notifyOwner(db, organisationId, {
        kind: "invoice.overdue",
        title: `Invoice ${invoice.number} is overdue`,
        body: `${client?.name ?? "A client"} owes ${amount}, due ${dueOn}.`,
        link: `/invoices/${invoice.id}`,
      });
      outcomes.push(claim);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `findOverdueInvoices: ${errors.length} of ${due.length} invoice(s) failed`);
  }
  return outcomes;
}
