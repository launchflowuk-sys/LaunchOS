import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { HOLDING_CLIENT_SLUG } from "../support/ingest-inbound-email.js";
import { createTicket } from "../support/create-ticket.js";

export const FindOverdueInvoicesInput = z.object({ now: z.date().default(() => new Date()) });
export type FindOverdueInvoicesInput = z.input<typeof FindOverdueInvoicesInput>;

export interface OverdueOutcome {
  invoice: typeof schema.invoices.$inferSelect;
  ticketId: string;
}

/**
 * Flips every sent invoice whose due date has passed to `overdue`, raises one
 * billing ticket per invoice and notifies the owner once. The ticket id lands
 * on the invoice's metadata and the status moves off `sent`, so the daily
 * sweep is idempotent: an already-overdue invoice is never re-ticketed.
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
  for (const invoice of due) {
    const [client] = await db.select({ name: schema.clients.name, slug: schema.clients.slug })
      .from(schema.clients).where(eq(schema.clients.id, invoice.clientId));
    if (client?.slug === HOLDING_CLIENT_SLUG) continue;

    const amount = `£${(invoice.totalPence / 100).toFixed(2)}`;
    const dueOn = invoice.dueAt.toISOString().slice(0, 10);

    const { ticket } = await createTicket(db, organisationId, {
      clientId: invoice.clientId,
      subject: `Invoice ${invoice.number} is overdue`,
      body: `Invoice ${invoice.number} for ${amount} was due on ${dueOn} and is still unpaid. Chase ${client?.name ?? "the client"} and record the payment once it lands.`,
      severity: "high",
      category: "billing",
      source: "monitor",
      actorKind: "system",
    });

    const [after] = await db.update(schema.invoices)
      .set({
        status: "overdue",
        metadata: { ...invoice.metadata, overdueTicketId: ticket.id },
        updatedAt: new Date(),
      })
      .where(eq(schema.invoices.id, invoice.id))
      .returning();
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "invoice.overdue",
      targetType: "invoice", targetId: invoice.id, before: invoice, after,
    });
    await notifyOwner(db, organisationId, {
      kind: "invoice.overdue",
      title: `Invoice ${invoice.number} is overdue`,
      body: `${client?.name ?? "A client"} owes ${amount}, due ${dueOn}.`,
      link: `/invoices/${invoice.id}`,
    });
    outcomes.push({ invoice: after!, ticketId: ticket.id });
  }
  return outcomes;
}
