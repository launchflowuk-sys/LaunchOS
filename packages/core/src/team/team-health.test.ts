import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { addStaffMember, seedOrgWithClient } from "../tasks/test-fixtures.js";
import { teamHealth } from "./team-health.js";

const NOW = new Date("2026-09-09T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("teamHealth", () => {
  it("scores each active member over the window and gives the organisation its own line", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const samId = await addStaffMember(db, organisationId, "Sam");
      const suspendedId = await addStaffMember(db, organisationId, "Gone");
      await db.update(schema.organisationMembers).set({ status: "suspended" })
        .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, suspendedId)));

      const ticket = (over: Partial<typeof schema.tickets.$inferInsert>) => ({
        organisationId, clientId, subject: "Site down", status: "open" as const, ...over,
      });
      await db.insert(schema.tickets).values([
        // Sam: three cases in the window, two answered (30 and 90 minutes), one resolved.
        ticket({ assignedUserId: samId, createdAt: ago(2 * DAY), firstResponseAt: ago(2 * DAY - 30 * 60_000), resolvedAt: ago(DAY), status: "resolved" }),
        ticket({ assignedUserId: samId, createdAt: ago(3 * DAY), firstResponseAt: ago(3 * DAY - 90 * 60_000) }),
        ticket({ assignedUserId: samId, createdAt: ago(5 * DAY) }),
        // Owner: one case, answered in 10 minutes; one old case resolved this week (resolved counts, assigned does not).
        ticket({ assignedUserId: ownerUserId, createdAt: ago(DAY), firstResponseAt: ago(DAY - 10 * 60_000) }),
        ticket({ assignedUserId: ownerUserId, createdAt: ago(60 * DAY), resolvedAt: ago(2 * DAY), status: "resolved" }),
        // Outside the window entirely.
        ticket({ assignedUserId: samId, createdAt: ago(45 * DAY), firstResponseAt: ago(45 * DAY - 5 * 60_000), resolvedAt: ago(44 * DAY), status: "closed" }),
        // Unassigned, open, answered yesterday in 50 minutes: counts for the organisation only.
        ticket({ createdAt: ago(DAY), firstResponseAt: ago(DAY - 50 * 60_000) }),
      ]);

      await db.insert(schema.tasks).values([
        { organisationId, clientId, phase: "support", title: "Late", assigneeUserId: samId, dueAt: ago(DAY), status: "in_progress" },
        { organisationId, clientId, phase: "support", title: "Late but done", assigneeUserId: samId, dueAt: ago(DAY), status: "done", completedAt: ago(HOUR) },
        { organisationId, clientId, phase: "support", title: "Not yet due", assigneeUserId: samId, dueAt: new Date(NOW.getTime() + DAY) },
        { organisationId, clientId, phase: "support", title: "Nobody's, late", dueAt: ago(3 * DAY) },
      ]);

      await db.insert(schema.timeEntries).values([
        { organisationId, userId: samId, startedAt: ago(2 * DAY), endedAt: ago(2 * DAY - 7.5 * HOUR) },
        { organisationId, userId: samId, startedAt: ago(HOUR), endedAt: null },
        { organisationId, userId: ownerUserId, startedAt: ago(40 * DAY), endedAt: ago(40 * DAY - 8 * HOUR) },
      ]);

      const [site] = await db.insert(schema.sites).values({ organisationId, clientId, name: "Main", primaryUrl: "https://example.test" }).returning();
      await db.insert(schema.incidents).values([
        { organisationId, siteId: site!.id, title: "Down", status: "open" },
        { organisationId, siteId: site!.id, title: "Was down", status: "resolved", resolvedAt: ago(HOUR) },
      ]);

      const health = await teamHealth(db, organisationId, { days: 30, now: NOW });
      expect(health.window.days).toBe(30);
      // A suspended member is not on the board.
      expect(health.members.map((m) => m.name)).toEqual(["Owner", "Sam"]);

      const sam = health.members.find((m) => m.name === "Sam")!;
      expect(sam).toMatchObject({ casesAssigned: 3, casesResolved: 1, medianFirstResponseMinutes: 60, overdueTasks: 1, hoursClocked: 8.5 });
      const owner = health.members.find((m) => m.name === "Owner")!;
      expect(owner).toMatchObject({ casesAssigned: 1, casesResolved: 1, medianFirstResponseMinutes: 10, overdueTasks: 0, hoursClocked: 0 });

      // Four replies in the window: 30, 90, 10, 50 → median 40.
      expect(health.organisation).toEqual({
        medianFirstResponseMinutes: 40,
        casesAnswered: 4,
        openCases: 4,
        openTasks: 3,
        overdueTasks: 2,
        openIncidents: 1,
      });
    });
  });

  it("is empty for another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await db.insert(schema.tickets).values({ organisationId: a.organisationId, clientId: a.clientId, subject: "A's case", assignedUserId: a.ownerUserId });
      const health = await teamHealth(db, b.organisationId, { now: NOW });
      expect(health.members).toHaveLength(1);
      expect(health.members[0]!.casesAssigned).toBe(0);
      expect(health.organisation.openCases).toBe(0);
    });
  });
});
