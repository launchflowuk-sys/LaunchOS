import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { createTicket } from "./create-ticket.js";

describe("createTicket", () => {
  it("creates a conversation, a first internal message, the ticket and a created event", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const { ticket, conversation } = await createTicket(db, org!.id, { clientId: client.id, subject: "Down", body: "Site is down", severity: "high", source: "monitor", category: "hosting" });
      expect(ticket.conversationId).toBe(conversation.id);
      expect(ticket.status).toBe("open");
      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toEqual(["created"]);
      const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
      expect(msgs).toHaveLength(1);
      // Raised by the monitor, about the client rather than by them: the body
      // is an internal note and the portal must not list the ticket at all.
      expect(msgs[0]!.direction).toBe("internal");
      expect(ticket.clientVisible).toBe(false);
      expect(conversation.channel).toBe("internal");
    });
  });

  it("marks a portal-raised ticket client-visible, with the client's own words inbound", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const { ticket, conversation } = await createTicket(db, org!.id, {
        clientId: client.id, subject: "Form broken", body: "Nothing arrives.",
        severity: "medium", source: "portal", actorKind: "client", actorId: "portal-user-1",
      });

      expect(ticket.clientVisible).toBe(true);
      expect(conversation.channel).toBe("portal");
      const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
      expect(msgs[0]!.direction).toBe("inbound");
      expect(msgs[0]!.authorKind).toBe("client");
    });
  });
});
