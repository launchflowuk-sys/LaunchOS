import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SLA_BREACH_NOTIFICATION_KIND, SLA_BREACH_NOTIFIED_AT, createTicket } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { SLA_SWEEP_CRON, runSlaSweep } from "./sla-sweep.js";

const HOUR = 3_600_000;
const quiet = { info() {}, error() {} };

async function organisation(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sla-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  return { orgId: org!.id, ownerId, clientId: client!.id };
}

async function portalCase(db: Db, orgId: string, clientId: string, hoursAgo: number, now: Date) {
  const { ticket } = await createTicket(db, orgId, { clientId, subject: "Site slow", body: "Since this morning", source: "portal", actorKind: "client" });
  await db.update(schema.tickets).set({ createdAt: new Date(now.getTime() - hoursAgo * HOUR) }).where(eq(schema.tickets.id, ticket.id));
  return ticket;
}

function breaches(db: Db, orgId: string) {
  return db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, SLA_BREACH_NOTIFICATION_KIND)));
}

describe("runSlaSweep", () => {
  it("runs every fifteen minutes", () => {
    expect(SLA_SWEEP_CRON).toBe("*/15 * * * *");
  });

  it("sweeps every organisation, rings the owner once per breached case, and finds nothing new on the next pass", async () => {
    await withTestDb(async (db) => {
      const now = new Date("2026-09-06T12:00:00Z");
      const a = await organisation(db);
      const b = await organisation(db);
      const late = await portalCase(db, a.orgId, a.clientId, 6, now);
      await portalCase(db, a.orgId, a.clientId, 1, now);
      await portalCase(db, b.orgId, b.clientId, 9, now);

      const first = await runSlaSweep(db, now, quiet);
      // Other tests' organisations share the database, so only the two seeded here are asserted on.
      expect(first.organisations).toBeGreaterThanOrEqual(2);
      const mine = await breaches(db, a.orgId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ userId: a.ownerId, link: `/cases/${late.id}` });
      expect(await breaches(db, b.orgId)).toHaveLength(1);
      const [stamped] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, late.id));
      expect((stamped!.metadata as Record<string, unknown>)[SLA_BREACH_NOTIFIED_AT]).toBeTruthy();

      const second = await runSlaSweep(db, new Date(now.getTime() + 15 * 60_000), quiet);
      expect(second.notified).toBe(0);
      expect(await breaches(db, a.orgId)).toHaveLength(1);
    });
  });
});
