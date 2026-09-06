import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { contentFixture } from "../content/test-fixtures.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { isCourtesyNotice } from "../support/courtesy-notice.js";
import { createTicket } from "../support/create-ticket.js";
import { updateTicket } from "../support/update-ticket.js";
import { CSAT_INVITED_AT, csatInviteBody, csatRatePath } from "./invite.js";
import { CsatRefused, getTicketRating, rateTicket } from "./rate-ticket.js";
import { csatSummary } from "./summary.js";

afterEach(() => setEnqueue(async () => {}));

async function resolvedCase(db: Db, orgId: string, clientId: string, portalUserId: string) {
  const { ticket } = await createTicket(db, orgId, { clientId, subject: "Booking form broken", body: "B", source: "portal", actorKind: "client", actorId: portalUserId });
  await updateTicket(db, orgId, { ticketId: ticket.id, status: "resolved", actorKind: "user", actorId: "u1" });
  return ticket;
}

describe("CSAT invite on resolve", () => {
  it("queues one branded 'Was this sorted?' per portal user, once, hidden from the thread, and emits message.queued", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserId } = await contentFixture(db, { withSubscription: false });
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { ticket } = await createTicket(db, orgId, { clientId, subject: "Booking form broken", body: "B", source: "portal", actorKind: "client", actorId: portalUserId });
      events.length = 0;

      const resolved = await updateTicket(db, orgId, { ticketId: ticket.id, status: "resolved", actorKind: "user", actorId: "u1" }, { APP_URL: "https://os.test" } as NodeJS.ProcessEnv);
      expect(typeof resolved.metadata[CSAT_INVITED_AT]).toBe("string");

      const notices = await db.select().from(schema.messages).where(and(
        eq(schema.messages.conversationId, ticket.conversationId!),
        isCourtesyNotice(),
      ));
      const invite = notices.find((n) => n.metadata["kind"] === "csat_invite");
      expect(invite).toBeDefined();
      expect(invite!.status).toBe("queued");
      expect(invite!.toEmail).toMatch(/@grays\.test$/);
      expect(invite!.subject).toMatch(/^Was this sorted\? Case #/);
      expect(invite!.body).toContain(`https://os.test${csatRatePath(ticket.id, 5)}`);
      expect(invite!.body).toContain("1 — Very poor");
      expect(events).toEqual([{ name: "message.queued", organisationId: orgId, messageId: invite!.id }]);

      // Reopen and resolve again: no second invite.
      await updateTicket(db, orgId, { ticketId: ticket.id, status: "in_progress" });
      await updateTicket(db, orgId, { ticketId: ticket.id, status: "resolved" });
      const again = await db.select().from(schema.messages).where(and(eq(schema.messages.conversationId, ticket.conversationId!), isCourtesyNotice()));
      expect(again.filter((n) => n.metadata["kind"] === "csat_invite")).toHaveLength(1);
    });
  });

  it("does not ask about an internal case", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const { ticket } = await createTicket(db, orgId, { clientId, subject: "Internal", body: "B", source: "manual" });
      const resolved = await updateTicket(db, orgId, { ticketId: ticket.id, status: "resolved" });
      expect(resolved.metadata[CSAT_INVITED_AT]).toBeUndefined();
      const notices = await db.select().from(schema.messages).where(and(eq(schema.messages.conversationId, ticket.conversationId!), isCourtesyNotice()));
      expect(notices).toHaveLength(0);
    });
  });

  it("renders the body with every score", () => {
    const body = csatInviteBody({ id: "12345678-0000-0000-0000-000000000000", subject: "S" }, "https://os.test");
    for (const n of [1, 2, 3, 4, 5]) expect(body).toContain(`https://os.test/portal/support/12345678-0000-0000-0000-000000000000/rate?score=${n}`);
    expect(body).toContain("#12345678");
  });
});

describe("rateTicket", () => {
  it("records, replaces, audits, and raises a low-score alert to the owner and assignee", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, portalUserId } = await contentFixture(db, { withSubscription: false });
      const staffId = randomUUID();
      await db.insert(schema.user).values({ id: staffId, name: "Staff", email: `s-${staffId}@example.test`, emailVerified: true });
      await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: staffId, role: "staff", status: "active" });
      const ticket = await resolvedCase(db, orgId, clientId, portalUserId);
      await db.update(schema.tickets).set({ assignedUserId: staffId }).where(eq(schema.tickets.id, ticket.id));

      const first = await rateTicket(db, orgId, { ticketId: ticket.id, actorUserId: portalUserId, score: 5, comment: "Brilliant" });
      expect(first.score).toBe(5);
      expect((await getTicketRating(db, orgId, { ticketId: ticket.id }))?.comment).toBe("Brilliant");

      const second = await rateTicket(db, orgId, { ticketId: ticket.id, actorUserId: portalUserId, score: 1, comment: "Actually not fixed" });
      expect(second.id).toBe(first.id);
      expect(second.score).toBe(1);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetId, ticket.id)));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["ticket.rated", "ticket.rating_changed"]));
      const alerts = await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "csat.low_score")));
      expect(alerts.map((a) => a.userId).sort()).toEqual([ownerId, staffId].sort());
      expect(alerts[0]!.body).toContain("Actually not fixed");
    });
  });

  it("refuses an open case, a stranger, another client's portal user, and another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await contentFixture(db, { withSubscription: false });
      const b = await contentFixture(db, { withSubscription: false, name: "Other" });
      const { ticket: open } = await createTicket(db, a.orgId, { clientId: a.clientId, subject: "Open", body: "B", source: "portal", actorKind: "client" });
      await expect(rateTicket(db, a.orgId, { ticketId: open.id, actorUserId: a.portalUserId, score: 4 })).rejects.toMatchObject({ reason: "not_resolved" });

      const ticket = await resolvedCase(db, a.orgId, a.clientId, a.portalUserId);
      await expect(rateTicket(db, a.orgId, { ticketId: ticket.id, actorUserId: "stranger", score: 4 })).rejects.toMatchObject({ reason: "not_portal_user" });
      await expect(rateTicket(db, a.orgId, { ticketId: ticket.id, actorUserId: b.portalUserId, score: 4 })).rejects.toMatchObject({ reason: "not_portal_user" });
      const cross = await rateTicket(db, b.orgId, { ticketId: ticket.id, actorUserId: b.portalUserId, score: 4 }).catch((e: unknown) => e);
      expect(cross).toBeInstanceOf(CsatRefused);
      expect((cross as CsatRefused).reason).toBe("not_found");
      expect(await getTicketRating(db, b.orgId, { ticketId: ticket.id })).toBeNull();
    });
  });
});

describe("csatSummary", () => {
  it("averages per member and for the organisation inside the window, listing members with nothing as null", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, portalUserId } = await contentFixture(db, { withSubscription: false });
      const staffId = randomUUID();
      await db.insert(schema.user).values({ id: staffId, name: "Staff", email: `s-${staffId}@example.test`, emailVerified: true });
      await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: staffId, role: "staff", status: "active", displayName: "Sam" });
      const now = new Date();

      const t1 = await resolvedCase(db, orgId, clientId, portalUserId);
      const t2 = await resolvedCase(db, orgId, clientId, portalUserId);
      const t3 = await resolvedCase(db, orgId, clientId, portalUserId);
      await db.update(schema.tickets).set({ assignedUserId: ownerId }).where(eq(schema.tickets.id, t1.id));
      await db.update(schema.tickets).set({ assignedUserId: ownerId }).where(eq(schema.tickets.id, t2.id));
      await rateTicket(db, orgId, { ticketId: t1.id, actorUserId: portalUserId, score: 5 });
      await rateTicket(db, orgId, { ticketId: t2.id, actorUserId: portalUserId, score: 4 });
      await rateTicket(db, orgId, { ticketId: t3.id, actorUserId: portalUserId, score: 2 });
      // An old rating falls outside the window.
      await db.update(schema.ticketRatings).set({ ratedAt: new Date(now.getTime() - 40 * 86_400_000) }).where(eq(schema.ticketRatings.ticketId, t3.id));

      const summary = await csatSummary(db, orgId, { days: 30, now: new Date(now.getTime() + 1000) });
      expect(summary.organisation).toEqual({ responses: 2, average: 4.5, invited: 3, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
      expect(summary.members).toEqual([
        { userId: ownerId, name: "Owner", role: "owner", responses: 2, average: 4.5 },
        { userId: staffId, name: "Sam", role: "staff", responses: 0, average: null },
      ]);

      const other = await contentFixture(db, { withSubscription: false, name: "Other" });
      expect((await csatSummary(db, other.orgId)).organisation.responses).toBe(0);
    });
  });
});
