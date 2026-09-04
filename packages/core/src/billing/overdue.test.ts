import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { createSubscription } from "./subscriptions.js";
import { createInvoiceFromSubscription, markInvoiceSent } from "./invoices.js";
import { requestInvoiceSend, sendApprovedInvoice } from "./invoice-send.js";
import { findOverdueInvoices, OVERDUE_CHASE_COOLDOWN_MS } from "./overdue.js";

/** A sent, past-due invoice on a client with an email address, ready to chase. */
async function chaseable(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od-${randomUUID()}` }).returning();
  const [ownerUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: org!.id, userId: ownerUser!.id, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "client@example.test",
  }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: "sent", issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, invoice: invoice! };
}

async function billingTickets(db: Db, organisationId: string) {
  return db.select().from(schema.tickets).where(and(
    eq(schema.tickets.organisationId, organisationId),
    eq(schema.tickets.category, "billing"),
  ));
}

/** Requests a send and immediately decides it approved, as a human would in the admin portal. */
async function approvedInvoiceSend(db: Db, orgId: string, invoiceId: string) {
  const requested = await requestInvoiceSend(db, orgId, { invoiceId, actorId: "u1" });
  const [approved] = await db.update(schema.approvals)
    .set({ status: "approved", decidedBy: "u1", decidedAt: new Date() })
    .where(eq(schema.approvals.id, requested.id))
    .returning();
  return approved!;
}

describe("findOverdueInvoices", () => {
  it("flips a sent, past-due invoice to overdue, raises one billing ticket and notifies the owner", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od-${randomUUID()}` }).returning();
      // notifyOwner delivers to the oldest active owner membership — the
      // fixture needs one on the books or the notification assertion below
      // has no recipient to land on.
      const [ownerUser] = await db.insert(schema.user)
        .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
      await db.insert(schema.organisationMembers)
        .values({ organisationId: org!.id, userId: ownerUser!.id, role: "owner", status: "active" });
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.billingProfiles).values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays Ltd" });
      const [pkg] = await db.insert(schema.packages)
        .values({ organisationId: org!.id, name: "Growth", slug: `g-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 }).returning();
      const { subscription } = await createSubscription(
        db, org!.id, { clientId: client!.id, packageId: pkg!.id, periodStart: new Date("2026-08-01T00:00:00Z") },
        new MockPaymentsAdapter(),
      );
      const invoice = await createInvoiceFromSubscription(db, org!.id, {
        subscriptionId: subscription.id, issuedAt: new Date("2026-08-01T00:00:00Z"),
      });
      await markInvoiceSent(db, org!.id, { invoiceId: invoice.id });

      const now = new Date("2026-09-04T07:30:00Z");
      const first = await findOverdueInvoices(db, org!.id, { now });
      expect(first).toHaveLength(1);
      expect(first[0]!.invoice.status).toBe("overdue");

      const tickets = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.subject).toContain(invoice.number);

      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org!.id));
      expect(notifications.length).toBeGreaterThan(0);

      // Idempotent: a second sweep neither re-flags nor re-tickets.
      expect(await findOverdueInvoices(db, org!.id, { now })).toHaveLength(0);
      const ticketsAgain = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(ticketsAgain).toHaveLength(1);
    });
  });

  it("does not raise a second ticket after the invoice has been chased by email", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await chaseable(db);
      const now = new Date("2026-09-04T07:30:00Z");

      // Sweep once: flagged, one ticket.
      expect(await findOverdueInvoices(db, orgId, { now })).toHaveLength(1);
      expect(await billingTickets(db, orgId)).toHaveLength(1);

      // Shoji works the ticket and chases the client — an approved send against
      // an invoice that is now `overdue`.
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      await sendApprovedInvoice(
        db, orgId, { approvalId: approval.id, actorId: "u1" }, new MockEmailAdapter(), "https://portal.test",
      );

      // The chase must not have reset the status, and the next morning's sweep
      // must not open a duplicate case for the same debt.
      const [chased] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(chased!.status).toBe("overdue");
      expect(await findOverdueInvoices(db, orgId, { now: new Date("2026-09-05T07:30:00Z") })).toHaveLength(0);
      expect(await billingTickets(db, orgId)).toHaveLength(1);
    });
  });

  it("chases again on the existing thread once the previous ticket is closed", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await chaseable(db);
      const first = await findOverdueInvoices(db, orgId, { now: new Date("2026-09-04T07:30:00Z") });
      const [firstTicket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, first[0]!.ticketId));

      await db.update(schema.tickets).set({ status: "closed", resolvedAt: new Date() })
        .where(eq(schema.tickets.id, firstTicket!.id));

      const second = await findOverdueInvoices(db, orgId, { now: new Date("2026-10-01T07:30:00Z") });

      expect(second).toHaveLength(1);
      expect(second[0]!.ticketId).not.toBe(firstTicket!.id);
      expect(second[0]!.invoice.status).toBe("overdue");
      // One thread, not two: the second chase is the next chapter of the first.
      const [secondTicket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, second[0]!.ticketId));
      expect(secondTicket!.conversationId).toBe(firstTicket!.conversationId);
      const conversations = await db.select().from(schema.conversations)
        .where(eq(schema.conversations.clientId, invoice.clientId));
      expect(conversations).toHaveLength(1);
      const messages = await db.select().from(schema.messages)
        .where(eq(schema.messages.conversationId, firstTicket!.conversationId!));
      expect(messages).toHaveLength(2);
    });
  });

  it("waits out the cooldown before chasing again, even once the ticket is closed", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await chaseable(db);
      const firstSweep = new Date("2026-09-04T07:30:00Z");
      const first = await findOverdueInvoices(db, orgId, { now: firstSweep });
      expect(first).toHaveLength(1);

      // Shoji works the case the same afternoon and closes it. Without the
      // cooldown the very next sweep opens another one, and another every
      // morning after that, until the client pays.
      await db.update(schema.tickets).set({ status: "closed", resolvedAt: new Date() })
        .where(eq(schema.tickets.id, first[0]!.ticketId));

      const nextMorning = new Date(firstSweep.getTime() + 86_400_000);
      expect(await findOverdueInvoices(db, orgId, { now: nextMorning })).toHaveLength(0);
      const dayBeforeCooldownExpires = new Date(firstSweep.getTime() + OVERDUE_CHASE_COOLDOWN_MS - 1);
      expect(await findOverdueInvoices(db, orgId, { now: dayBeforeCooldownExpires })).toHaveLength(0);
      expect(await billingTickets(db, orgId)).toHaveLength(1);

      // A week on and still unpaid: chase it again.
      const afterCooldown = new Date(firstSweep.getTime() + OVERDUE_CHASE_COOLDOWN_MS);
      const second = await findOverdueInvoices(db, orgId, { now: afterCooldown });
      expect(second).toHaveLength(1);
      expect(second[0]!.ticketId).not.toBe(first[0]!.ticketId);
      expect(await billingTickets(db, orgId)).toHaveLength(2);

      // And the clock restarts from the second chase, not the first.
      const [chased] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(chased!.metadata["lastChasedAt"]).toBe(afterCooldown.toISOString());
    });
  });

  it("merges the chase stamp into the invoice metadata instead of overwriting it", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await chaseable(db);
      // Everything a send leaves behind. A whole-object write would take the
      // row as it stood when the sweep read it and put every one of these keys
      // back — dropping anything a concurrent send had added in between.
      const before = {
        sentAt: "2026-08-02T09:00:00.000Z",
        emailedAt: "2026-08-02T09:00:01.000Z",
        sendHistory: [{ approvalId: randomUUID(), at: "2026-08-02T09:00:00.000Z", actorId: "u1" }],
      };
      await db.update(schema.invoices).set({ metadata: before }).where(eq(schema.invoices.id, invoice.id));

      const now = new Date("2026-09-04T07:30:00Z");
      const [outcome] = await findOverdueInvoices(db, orgId, { now });

      const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(after!.metadata).toEqual({
        ...before,
        overdueTicketId: outcome!.ticketId,
        lastChasedAt: now.toISOString(),
      });
    });
  });

  it("ignores drafts, paid and voided invoices", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od2-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const base = {
        organisationId: org!.id, clientId: client!.id,
        issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"),
        subtotalPence: 100, vatPence: 20, totalPence: 120,
      };
      await db.insert(schema.invoices).values([
        { ...base, number: "LF-2026-9001", status: "draft" as const },
        { ...base, number: "LF-2026-9002", status: "paid" as const },
        { ...base, number: "LF-2026-9003", status: "void" as const },
      ]);
      expect(await findOverdueInvoices(db, org!.id, { now: new Date("2026-09-04T00:00:00Z") })).toHaveLength(0);
    });
  });

  it("continues past one invoice's failure so the rest of the sweep still lands, but reports it", async () => {
    await withTestDb(async (db) => {
      const [orgA] = await db.insert(schema.organisations).values({ name: "A", slug: `od3a-${randomUUID()}` }).returning();
      const [orgB] = await db.insert(schema.organisations).values({ name: "B", slug: `od3b-${randomUUID()}` }).returning();
      const [ownerUser] = await db.insert(schema.user)
        .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
      await db.insert(schema.organisationMembers)
        .values({ organisationId: orgA!.id, userId: ownerUser!.id, role: "owner", status: "active" });

      const [goodClient] = await db.insert(schema.clients)
        .values({ organisationId: orgA!.id, name: "Good Co", slug: `good-${randomUUID()}` }).returning();
      // A client that belongs to a different organisation than the invoice
      // pointing at it — an integrity gap `createTicketInTx`'s
      // `assertClientInOrganisation` catches and throws on. The sweep must
      // survive that rather than let it take down the whole run.
      const [strayClient] = await db.insert(schema.clients)
        .values({ organisationId: orgB!.id, name: "Stray Co", slug: `stray-${randomUUID()}` }).returning();

      const base = {
        organisationId: orgA!.id,
        issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"),
        subtotalPence: 100, vatPence: 20, totalPence: 120, status: "sent" as const,
      };
      const [goodInvoice] = await db.insert(schema.invoices)
        .values({ ...base, clientId: goodClient!.id, number: "LF-2026-8001" }).returning();
      const [badInvoice] = await db.insert(schema.invoices)
        .values({ ...base, clientId: strayClient!.id, number: "LF-2026-8002" }).returning();

      const now = new Date("2026-09-04T00:00:00Z");
      await expect(findOverdueInvoices(db, orgA!.id, { now })).rejects.toThrow(/1 of 2/);

      const [goodAfter] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, goodInvoice!.id));
      expect(goodAfter!.status).toBe("overdue");

      // The failed invoice's claim was rolled back with the rest of its
      // transaction — it stays `sent`, not stuck half-flipped.
      const [badAfter] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, badInvoice!.id));
      expect(badAfter!.status).toBe("sent");

      const tickets = await db.select().from(schema.tickets).where(eq(schema.tickets.organisationId, orgA!.id));
      expect(tickets).toHaveLength(1);
    });
  });
});
