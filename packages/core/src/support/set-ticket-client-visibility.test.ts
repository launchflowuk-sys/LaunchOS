import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { createTicket } from "./create-ticket.js";
import { setTicketClientVisibility } from "./set-ticket-client-visibility.js";

async function seedInternalCase(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const client = await createClient(db, org!.id, { name: "C" });
  const { ticket } = await createTicket(db, org!.id, {
    clientId: client.id, subject: "Overdue invoice chase", body: "Chasing INV-1.",
    severity: "low", source: "agent", actorKind: "agent",
  });
  return { organisationId: org!.id, client, ticket };
}

describe("setTicketClientVisibility", () => {
  it("shares an internal case with the client, on the history and in the audit log", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedInternalCase(db);
      expect(ticket.clientVisible).toBe(false);

      const after = await setTicketClientVisibility(db, organisationId, {
        ticketId: ticket.id, clientVisible: true, actorKind: "user", actorId: "u1",
      });
      expect(after.clientVisible).toBe(true);

      const events = await db
        .select()
        .from(schema.ticketEvents)
        .where(and(eq(schema.ticketEvents.ticketId, ticket.id), eq(schema.ticketEvents.kind, "note")));
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toMatchObject({ clientVisible: true });

      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(and(
          eq(schema.auditLog.organisationId, organisationId),
          eq(schema.auditLog.action, "ticket.shared_with_client"),
        ));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.targetId).toBe(ticket.id);
    });
  });

  it("takes it back again", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedInternalCase(db);
      await setTicketClientVisibility(db, organisationId, { ticketId: ticket.id, clientVisible: true, actorId: "u1" });

      const hidden = await setTicketClientVisibility(db, organisationId, {
        ticketId: ticket.id, clientVisible: false, actorId: "u1",
      });
      expect(hidden.clientVisible).toBe(false);

      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(and(
          eq(schema.auditLog.organisationId, organisationId),
          eq(schema.auditLog.action, "ticket.hidden_from_client"),
        ));
      expect(audit).toHaveLength(1);
    });
  });

  it("writes no history when nothing changed", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedInternalCase(db);

      await setTicketClientVisibility(db, organisationId, { ticketId: ticket.id, clientVisible: false, actorId: "u1" });

      const events = await db
        .select()
        .from(schema.ticketEvents)
        .where(and(eq(schema.ticketEvents.ticketId, ticket.id), eq(schema.ticketEvents.kind, "note")));
      expect(events).toHaveLength(0);
    });
  });

  it("refuses a ticket belonging to another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await seedInternalCase(db);
      const theirs = await seedInternalCase(db);

      await expect(
        setTicketClientVisibility(db, mine.organisationId, {
          ticketId: theirs.ticket.id, clientVisible: true, actorId: "u1",
        }),
      ).rejects.toThrow();

      const [untouched] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, theirs.ticket.id));
      expect(untouched!.clientVisible).toBe(false);
    });
  });
});
