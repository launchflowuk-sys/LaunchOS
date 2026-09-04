import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createClient } from "../clients/create-client.js";
import { createTicket } from "./create-ticket.js";
import { replyAsClient } from "./reply-as-client.js";
import { updateTicket } from "./update-ticket.js";

/** Captures what `emit` would have put on the queue for the duration of a test. */
async function withCapturedEvents<T>(run: (events: DomainEvent[]) => Promise<T>): Promise<T> {
  const events: DomainEvent[] = [];
  setEnqueue(async (event) => {
    events.push(event);
  });
  try {
    return await run(events);
  } finally {
    setEnqueue(async () => {});
  }
}

async function seedCase(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const ownerId = crypto.randomUUID();
  const [owner] = await db
    .insert(schema.user)
    .values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner" });

  const client = await createClient(db, org!.id, { name: "C" });
  const { ticket, conversation } = await createTicket(db, org!.id, {
    clientId: client.id, subject: "Contact form is down", body: "Nothing arrives.",
    severity: "medium", source: "portal", actorKind: "client", actorId: "portal-user-1",
  });
  return { organisationId: org!.id, owner: owner!, client, ticket, conversation };
}

describe("replyAsClient", () => {
  it("writes the reply inbound as the client and moves the thread to the top", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedCase(db);

      const { message } = await replyAsClient(db, organisationId, {
        conversationId: conversation.id, body: "This is still broken.", actorId: "portal-user-1",
      });

      expect(message.direction).toBe("inbound");
      expect(message.authorKind).toBe("client");
      // Nothing here is email: no status, no addresses, nothing to send.
      expect(message.status).toBeNull();
      expect(message.toEmail).toBeNull();

      const [fresh] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
      expect(fresh!.status).toBe("open");
      expect(fresh!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(conversation.lastMessageAt!.getTime());

      // The Inbox's "needs reply" badge is `lastDirection === "inbound"`.
      const [last] = await db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.direction, "inbound")));
      expect(last).toBeDefined();
    });
  });

  it("reopens a resolved ticket, records the status change and emits ticket.client_replied", async () => {
    await withTestDb(async (db) => {
      await withCapturedEvents(async (events) => {
        const { organisationId, ticket, conversation } = await seedCase(db);
        await updateTicket(db, organisationId, { ticketId: ticket.id, status: "resolved", actorKind: "user" });
        events.length = 0;

        await replyAsClient(db, organisationId, {
          conversationId: conversation.id, body: "It happened again.", actorId: "portal-user-1",
        });

        const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
        expect(after!.status).toBe("open");
        expect(after!.resolvedAt).toBeNull();

        const changes = await db
          .select()
          .from(schema.ticketEvents)
          .where(and(eq(schema.ticketEvents.ticketId, ticket.id), eq(schema.ticketEvents.kind, "status_changed")));
        const reopen = changes.find((e) => e.actorKind === "client");
        expect(reopen?.data).toMatchObject({ from: "resolved", to: "open" });

        // Not `ticket.created`: this ticket already has a history, and that
        // event would start a second Support Triage run over it.
        expect(events).toEqual([{ name: "ticket.client_replied", organisationId, ticketId: ticket.id }]);
      });
    });
  });

  it("clears waiting_client and leaves an open ticket alone, emitting client_replied either way", async () => {
    await withTestDb(async (db) => {
      await withCapturedEvents(async (events) => {
        const { organisationId, ticket, conversation } = await seedCase(db);
        await updateTicket(db, organisationId, { ticketId: ticket.id, status: "waiting_client", actorKind: "user" });
        events.length = 0;

        await replyAsClient(db, organisationId, {
          conversationId: conversation.id, body: "Here are the details you asked for.", actorId: "portal-user-1",
        });

        const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
        expect(after!.status).toBe("open");
        // The fact is "the client replied", whether or not it revived the case.
        // Nothing routes it to an agent — see apps/worker/src/jobs/dispatch-event.ts.
        expect(events).toEqual([{ name: "ticket.client_replied", organisationId, ticketId: ticket.id }]);

        await replyAsClient(db, organisationId, {
          conversationId: conversation.id, body: "One more thing.", actorId: "portal-user-1",
        });
        const [stillOpen] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
        expect(stillOpen!.status).toBe("open");
        expect(events).toHaveLength(2);
        expect(events.every((e) => e.name === "ticket.client_replied")).toBe(true);
      });
    });
  });

  it("tells the assignee, falling back to the owner when nobody is assigned", async () => {
    await withTestDb(async (db) => {
      const { organisationId, owner, ticket, conversation } = await seedCase(db);

      await replyAsClient(db, organisationId, {
        conversationId: conversation.id, body: "Any news?", actorId: "portal-user-1",
      });
      const toOwner = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.userId, owner.id)));
      expect(toOwner).toHaveLength(1);
      expect(toOwner[0]!.kind).toBe("support.portal_reply");
      expect(toOwner[0]!.link).toBe(`/cases/${ticket.id}`);

      // Assign it, and the next reply goes to the assignee instead.
      const staffId = crypto.randomUUID();
      await db
        .insert(schema.user)
        .values({ id: staffId, name: "Staff", email: `staff-${staffId}@example.test`, emailVerified: true });
      await db.insert(schema.organisationMembers).values({ organisationId, userId: staffId, role: "staff" });
      await db.update(schema.tickets).set({ assignedUserId: staffId }).where(eq(schema.tickets.id, ticket.id));

      await replyAsClient(db, organisationId, {
        conversationId: conversation.id, body: "Still nothing.", actorId: "portal-user-1",
      });
      const toStaff = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.userId, staffId)));
      expect(toStaff).toHaveLength(1);
    });
  });

  it("writes the client timeline entry", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client, conversation } = await seedCase(db);

      await replyAsClient(db, organisationId, {
        conversationId: conversation.id, body: "Adding a screenshot.", actorId: "portal-user-1",
      });

      const activity = await db
        .select()
        .from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.clientId, client.id), eq(schema.activityEvents.kind, "support.portal_reply")));
      expect(activity).toHaveLength(1);
    });
  });

  it("refuses a case the client was never shown, writing nothing", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await seedCase(db);
      // A case the agency raised about the client: `client_visible` is false,
      // and the portal never lists it.
      const internal = await createTicket(db, organisationId, {
        clientId: client.id, subject: "Overdue invoice chase", body: "Chasing INV-1.",
        severity: "low", source: "agent", actorKind: "agent",
      });
      expect(internal.ticket.clientVisible).toBe(false);

      await expect(
        replyAsClient(db, organisationId, {
          conversationId: internal.conversation.id, body: "Who are you?", actorId: "portal-user-1",
          clientId: client.id,
        }),
      ).rejects.toThrow(/not visible to the client/);

      // The guard is the boundary, not a message that got written and then
      // apologised for: nothing landed and the case did not move.
      const messages = await db
        .select()
        .from(schema.messages)
        .where(and(
          eq(schema.messages.conversationId, internal.conversation.id),
          eq(schema.messages.direction, "inbound"),
        ));
      expect(messages).toHaveLength(0);
      const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, internal.ticket.id));
      expect(after!.status).toBe("open");
    });
  });

  it("refuses a conversation belonging to another client or another organisation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedCase(db);
      const other = await seedCase(db);
      const sibling = await createClient(db, organisationId, { name: "Sibling" });

      await expect(
        replyAsClient(db, organisationId, {
          conversationId: conversation.id, body: "hi", actorId: "x", clientId: sibling.id,
        }),
      ).rejects.toThrow(/another client/);

      await expect(
        replyAsClient(db, organisationId, { conversationId: other.conversation.id, body: "hi", actorId: "x" }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});
