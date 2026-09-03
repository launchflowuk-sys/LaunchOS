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
    });
  });
});
