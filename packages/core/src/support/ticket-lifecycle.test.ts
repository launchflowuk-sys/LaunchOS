import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { assignTicket } from "./assign-ticket.js";
import { createTicket } from "./create-ticket.js";
import { escalateTicket } from "./escalate-ticket.js";
import { slaDueAt } from "./sla.js";
import { updateTicket } from "./update-ticket.js";

async function seedTicket(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  const { ticket } = await createTicket(db, org!.id, { clientId: client!.id, subject: "S", body: "B", source: "email" });
  return { organisationId: org!.id, ticket };
}

describe("ticket lifecycle", () => {
  it("computes the SLA window from severity", () => {
    const from = new Date("2026-09-04T10:00:00Z");
    expect(slaDueAt("critical", from).toISOString()).toBe("2026-09-04T12:00:00.000Z");
    expect(slaDueAt("low", from).toISOString()).toBe("2026-09-07T10:00:00.000Z");
  });

  it("stores triage output, recomputes the SLA on a severity change and stamps resolved_at", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedTicket(db);

      const triaged = await updateTicket(db, organisationId, {
        ticketId: ticket.id, category: "dns", severity: "critical", status: "triaged",
        triage: { category: "dns", severity: "critical", summary: "Nameservers wrong", suggestedFix: "Repoint NS", confidence: 0.82 },
        actorKind: "agent", actorId: "support-triage",
      });
      expect(triaged.status).toBe("triaged");
      expect(triaged.triage).toMatchObject({ category: "dns", confidence: 0.82 });
      expect(triaged.slaDueAt!.getTime()).toBe(slaDueAt("critical", triaged.createdAt).getTime());
      expect(triaged.resolvedAt).toBeNull();

      const resolved = await updateTicket(db, organisationId, { ticketId: ticket.id, status: "resolved", actorKind: "user", actorId: "u1" });
      expect(resolved.resolvedAt).toBeInstanceOf(Date);

      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toContain("status_changed");
    });
  });

  it("assigns explicitly and escalates with a reason", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ticket } = await seedTicket(db);

      const assigned = await assignTicket(db, organisationId, {
        ticketId: ticket.id, assignedUserId: "user-1", actorKind: "agent", actorId: "support-triage",
      });
      expect(assigned.assignedUserId).toBe("user-1");

      const escalated = await escalateTicket(db, organisationId, {
        ticketId: ticket.id, reason: "Needs Shoji", actorKind: "agent", actorId: "support-triage",
      });
      expect(escalated.escalated).toBe(true);
      expect(escalated.escalationReason).toBe("Needs Shoji");
      expect(escalated.severity).toBe("high");

      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id));
      expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["assigned", "escalated"]));
    });
  });
});
