import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicketInTx } from "../support/create-ticket.js";
import { HOLDING_CLIENT_SLUG } from "../support/ingest-inbound-email.js";
import { canTransition, statusesThatCanBecome } from "./invoices.js";

export const FindOverdueInvoicesInput = z.object({ now: z.date().default(() => new Date()) });
export type FindOverdueInvoicesInput = z.input<typeof FindOverdueInvoicesInput>;

export interface OverdueOutcome {
  invoice: typeof schema.invoices.$inferSelect;
  ticketId: string;
}

/**
 * The statuses a sweep may act on, derived from the transition map rather than
 * hard-coded: everything that can *become* overdue (`sent`), plus `overdue`
 * itself via its self-transition, so an arrear that is still unpaid after its
 * chase ticket closed can be chased again.
 */
const SWEEPABLE_STATUSES = statusesThatCanBecome("overdue");

/** A chase ticket in one of these is finished; anything else is still being worked. */
const SETTLED_TICKET_STATUSES = ["resolved", "closed"] as const;

/**
 * Flips every sent invoice whose due date has passed to `overdue`, raises one
 * billing ticket per invoice and notifies the owner once.
 *
 * **One open chase per invoice.** `metadata.overdueTicketId` points at the
 * ticket the last sweep raised, and it is *read* as well as written: while that
 * ticket is still open the invoice is skipped entirely — no second ticket, no
 * second conversation, no repeat owner notification, however many times the
 * sweep runs and however often the invoice is chased by email in between. Once
 * the ticket is resolved or closed and the money still has not arrived, the
 * sweep may raise a fresh ticket, and it hangs that ticket off the **existing
 * conversation** so the whole chase reads as one thread rather than a pile of
 * identical cases.
 *
 * Each invoice is isolated in its own transaction that (a) takes the invoice
 * row lock with `SELECT ... FOR UPDATE` as its first statement, so two
 * overlapping sweeps serialise: the second one re-reads the row the first
 * committed, sees the open ticket it just raised, and skips; (b) re-checks
 * under that lock that the invoice is still sweepable — a `paid` or `void` that
 * landed between the candidate query and the lock ends the work here; (c)
 * raises the ticket via `createTicketInTx` on the same `tx`; (d) stamps
 * `metadata.overdueTicketId`; (e) audits. `ticket.created` is emitted and the
 * owner notified only after that transaction commits — never a partial state.
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
    inArray(schema.invoices.status, SWEEPABLE_STATUSES),
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
      const body = `Invoice ${invoice.number} for ${amount} was due on ${dueOn} and is still unpaid. Chase ${client?.name ?? "the client"} and record the payment once it lands.`;

      const claim = await db.transaction(async (tx) => {
        const inner = tx as unknown as Db;
        // The lock is the first statement, so a concurrent sweep waits here and
        // then re-reads whatever this one commits — including the ticket id
        // stamped below, which is what stops it raising a duplicate.
        const [locked] = await tx.select().from(schema.invoices)
          .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.organisationId, organisationId)))
          .for("update");
        if (!locked) return undefined;
        if (!canTransition(locked.status, "overdue")) return undefined; // paid or voided since the scan
        if (locked.dueAt >= v.now) return undefined;

        const prior = await priorChase(inner, organisationId, locked);
        if (prior?.open) return undefined; // the last chase is still being worked

        const [claimed] = await tx.update(schema.invoices)
          .set({ status: "overdue", updatedAt: new Date() })
          .where(eq(schema.invoices.id, locked.id))
          .returning();

        // A finished chase leaves its conversation behind: reuse it so a second
        // chase reads as the next chapter of one thread. `createTicketInTx`
        // writes no opening message when it is handed a conversation, so the
        // chase note is added here.
        const reuseConversationId = prior?.conversationId ?? undefined;
        const { ticket } = await createTicketInTx(inner, organisationId, {
          clientId: locked.clientId,
          conversationId: reuseConversationId,
          subject: `Invoice ${invoice.number} is overdue`,
          body,
          severity: "high",
          category: "billing",
          source: "monitor",
          actorKind: "system",
        });
        if (reuseConversationId) await appendChaseNote(inner, organisationId, reuseConversationId, body);

        const [after] = await tx.update(schema.invoices)
          .set({ metadata: { ...claimed!.metadata, overdueTicketId: ticket.id }, updatedAt: new Date() })
          .where(eq(schema.invoices.id, locked.id))
          .returning();
        await recordAudit(inner, organisationId, {
          actorKind: "system", action: "invoice.overdue",
          targetType: "invoice", targetId: locked.id, before: locked, after,
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

interface PriorChase {
  open: boolean;
  conversationId: string | null;
}

/**
 * The chase ticket the last sweep raised for this invoice, if it still exists.
 * `metadata` is untyped JSON that anything could have written, so the id is
 * validated as a uuid before it reaches a uuid column.
 */
async function priorChase(
  db: Db,
  organisationId: string,
  invoice: typeof schema.invoices.$inferSelect,
): Promise<PriorChase | undefined> {
  const parsed = z.string().uuid().safeParse(invoice.metadata["overdueTicketId"]);
  if (!parsed.success) return undefined;
  const [ticket] = await db
    .select({ status: schema.tickets.status, conversationId: schema.tickets.conversationId })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, parsed.data), eq(schema.tickets.organisationId, organisationId)));
  if (!ticket) return undefined;
  return {
    open: !(SETTLED_TICKET_STATUSES as readonly string[]).includes(ticket.status),
    conversationId: ticket.conversationId,
  };
}

/** The chase note on a reused thread, plus the conversation bookkeeping that goes with it. */
async function appendChaseNote(db: Db, organisationId: string, conversationId: string, body: string): Promise<void> {
  const now = new Date();
  await db.insert(schema.messages).values({
    organisationId, conversationId, direction: "internal", authorKind: "system", body,
  });
  await db.update(schema.conversations)
    .set({ status: "open", lastMessageAt: now, updatedAt: now })
    .where(eq(schema.conversations.id, conversationId));
}
