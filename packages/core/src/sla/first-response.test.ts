import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createTicket } from "../support/create-ticket.js";
import { casesPastFirstResponse, notifySlaBreaches, SLA_BREACH_NOTIFIED_AT } from "./first-response.js";

const HOUR = 3_600_000;

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sla-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  return { orgId: org!.id, ownerId, clientId: client!.id };
}

async function ageTicket(db: Db, ticketId: string, hoursAgo: number, now: Date) {
  await db.update(schema.tickets).set({ createdAt: new Date(now.getTime() - hoursAgo * HOUR) }).where(eq(schema.tickets.id, ticketId));
}

describe("first-response SLA", () => {
  it("finds only open, client-visible, unanswered cases older than the promise", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await seed(db);
      const now = new Date("2026-09-06T12:00:00Z");
      const make = (source: "portal" | "manual") =>
        createTicket(db, orgId, { clientId, subject: "S", body: "B", source, actorKind: source === "portal" ? "client" : "user" });

      const old = (await make("portal")).ticket;
      await ageTicket(db, old.id, 6, now);
      const fresh = (await make("portal")).ticket;
      await ageTicket(db, fresh.id, 1, now);
      const internal = (await make("manual")).ticket;
      await ageTicket(db, internal.id, 10, now);
      const answered = (await make("portal")).ticket;
      await ageTicket(db, answered.id, 10, now);
      await db.update(schema.tickets).set({ firstResponseAt: now }).where(eq(schema.tickets.id, answered.id));
      const waiting = (await make("portal")).ticket;
      await ageTicket(db, waiting.id, 10, now);
      await db.update(schema.tickets).set({ status: "waiting_client" }).where(eq(schema.tickets.id, waiting.id));

      const breached = await casesPastFirstResponse(db, orgId, { now });
      expect(breached.map((t) => t.id)).toEqual([old.id]);
      expect(await casesPastFirstResponse(db, orgId, { now, hours: 0.5 })).toHaveLength(2);
    });
  });

  it("notifies the owner and the assignee once per case and stamps the ticket", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await seed(db);
      const staffId = randomUUID();
      await db.insert(schema.user).values({ id: staffId, name: "Staff", email: `s-${staffId}@example.test`, emailVerified: true });
      await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: staffId, role: "staff", status: "active" });
      const now = new Date("2026-09-06T12:00:00Z");
      const { ticket } = await createTicket(db, orgId, { clientId, subject: "Site slow", body: "B", source: "portal", actorKind: "client" });
      await ageTicket(db, ticket.id, 7, now);
      await db.update(schema.tickets).set({ assignedUserId: staffId }).where(eq(schema.tickets.id, ticket.id));

      const first = await notifySlaBreaches(db, orgId, { now });
      expect(first).toEqual({ hours: 4, breached: 1, notified: [ticket.id] });
      const second = await notifySlaBreaches(db, orgId, { now });
      expect(second).toEqual({ hours: 4, breached: 0, notified: [] });

      const [stamped] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
      expect(stamped!.metadata[SLA_BREACH_NOTIFIED_AT]).toBe(now.toISOString());

      const notifications = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "case.sla_breached")));
      expect(notifications.map((n) => n.userId).sort()).toEqual([ownerId, staffId].sort());
      expect(notifications[0]!.title).toMatch(/no reply for 7h/);
      expect(notifications[0]!.link).toBe(`/cases/${ticket.id}`);

      const [audit] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "ticket.sla_breached")));
      expect(audit?.targetId).toBe(ticket.id);
    });
  });

  it("reads the promise from organisation metadata and never crosses organisations", async () => {
    await withTestDb(async (db) => {
      const a = await seed(db);
      const b = await seed(db);
      await db.update(schema.organisations).set({ metadata: { firstResponseHours: 1 } }).where(eq(schema.organisations.id, a.orgId));
      const now = new Date("2026-09-06T12:00:00Z");
      const { ticket } = await createTicket(db, a.orgId, { clientId: a.clientId, subject: "S", body: "B", source: "portal", actorKind: "client" });
      await ageTicket(db, ticket.id, 2, now);

      expect(await casesPastFirstResponse(db, b.orgId, { now })).toHaveLength(0);
      const result = await notifySlaBreaches(db, a.orgId, { now });
      expect(result.hours).toBe(1);
      expect(result.notified).toEqual([ticket.id]);
      expect(await notifySlaBreaches(db, b.orgId, { now })).toEqual({ hours: 4, breached: 0, notified: [] });
    });
  });
});
