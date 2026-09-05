import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { addStaffMember, seedOrgWithClient } from "../tasks/test-fixtures.js";
import { recentOpsActivity } from "./ops-activity.js";
import { createOpsBrief, getOpsBrief, latestOpsBrief, listOpsBriefs } from "./ops-briefs.js";
import { opsMetricsSnapshot } from "./ops-metrics.js";

const NOW = new Date("2026-09-09T06:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("ops briefs", () => {
  it("writes one brief per day, replaces a re-run in place, audits both, and lists newest first", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      expect(await latestOpsBrief(db, organisationId)).toBeNull();

      const first = await createOpsBrief(db, organisationId, {
        briefDate: "2026-09-08", bodyMd: "## Yesterday\nQuiet.", highlights: [{ label: "Approve 2 posts", link: "/approvals" }],
        actorKind: "agent", actorId: "ops-brief",
      });
      expect(first.replaced).toBe(false);
      expect(first.brief.highlights).toEqual([{ label: "Approve 2 posts", link: "/approvals" }]);

      const today = await createOpsBrief(db, organisationId, { briefDate: "2026-09-09", bodyMd: "## Yesterday\nBusy." });
      const rerun = await createOpsBrief(db, organisationId, {
        briefDate: "2026-09-09", bodyMd: "## Yesterday\nBusier.", highlights: [], agentRunId: crypto.randomUUID(), actorKind: "agent", actorId: "ops-brief",
      });
      expect(rerun.replaced).toBe(true);
      expect(rerun.brief.id).toBe(today.brief.id);
      expect(rerun.brief.bodyMd).toBe("## Yesterday\nBusier.");

      expect((await latestOpsBrief(db, organisationId))?.id).toBe(today.brief.id);
      expect((await listOpsBriefs(db, organisationId)).map((b) => b.briefDate)).toEqual(["2026-09-09", "2026-09-08"]);
      expect((await listOpsBriefs(db, organisationId, { limit: 1, offset: 1 })).map((b) => b.briefDate)).toEqual(["2026-09-08"]);
      expect((await getOpsBrief(db, organisationId, { briefId: first.brief.id }))?.bodyMd).toBe("## Yesterday\nQuiet.");

      const audits = await db.select({ action: schema.auditLog.action, actorId: schema.auditLog.actorId }).from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetType, "ops_brief")));
      expect(audits.map((a) => a.action).sort()).toEqual(["ops_brief.created", "ops_brief.created", "ops_brief.replaced"]);

      // Another organisation sees nothing and cannot read by id.
      const other = await seedOrgWithClient(db);
      expect(await latestOpsBrief(db, other.organisationId)).toBeNull();
      expect(await getOpsBrief(db, other.organisationId, { briefId: first.brief.id })).toBeNull();
      // The same date in another organisation is its own row.
      const theirs = await createOpsBrief(db, other.organisationId, { briefDate: "2026-09-09", bodyMd: "Theirs." });
      expect(theirs.replaced).toBe(false);
      expect(theirs.brief.id).not.toBe(today.brief.id);
    });
  });

  it("rejects a malformed date and an empty body", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await expect(createOpsBrief(db, organisationId, { briefDate: "9 Sep 2026", bodyMd: "x" })).rejects.toThrow();
      await expect(createOpsBrief(db, organisationId, { briefDate: "2026-09-09", bodyMd: "   " })).rejects.toThrow();
    });
  });
});

describe("opsMetricsSnapshot", () => {
  it("reads every section from the organisation's own rows for the window", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const samId = await addStaffMember(db, organisationId, "Sam");
      const other = await seedOrgWithClient(db);

      const ticket = (over: Partial<typeof schema.tickets.$inferInsert>) => ({ organisationId, clientId, subject: "Case", ...over });
      await db.insert(schema.tickets).values([
        ticket({ createdAt: ago(2 * HOUR), firstResponseAt: ago(HOUR), status: "triaged" }),                       // opened, answered in 60m
        ticket({ createdAt: ago(3 * HOUR), status: "open", slaDueAt: ago(HOUR) }),                                  // opened, unanswered, SLA breached
        ticket({ createdAt: ago(30 * HOUR), resolvedAt: ago(HOUR), status: "resolved", firstResponseAt: ago(29 * HOUR) }), // resolved in window; reply outside
        ticket({ createdAt: ago(50 * HOUR), status: "in_progress", escalated: true, firstResponseAt: ago(48 * HOUR) }),   // old, open, escalated
        ticket({ createdAt: ago(100 * HOUR), status: "closed", resolvedAt: ago(90 * HOUR) }),                       // nothing
        { organisationId: other.organisationId, clientId: other.clientId, subject: "Theirs", createdAt: ago(HOUR) },
      ]);

      await db.insert(schema.tasks).values([
        { organisationId, clientId, phase: "support", title: "Late", dueAt: ago(HOUR) },
        { organisationId, clientId, phase: "support", title: "Done", status: "done", completedAt: ago(2 * HOUR) },
        { organisationId, clientId, phase: "support", title: "Open", dueAt: new Date(NOW.getTime() + HOUR) },
      ]);

      const [site] = await db.insert(schema.sites).values({ organisationId, clientId, name: "Main", primaryUrl: "https://example.test" }).returning();
      await db.insert(schema.incidents).values([
        { organisationId, siteId: site!.id, title: "Down", status: "acknowledged", openedAt: ago(HOUR) },
        { organisationId, siteId: site!.id, title: "Fixed", status: "resolved", openedAt: ago(5 * HOUR), resolvedAt: ago(4 * HOUR) },
      ]);

      await db.insert(schema.approvals).values([
        { organisationId, kind: "tool_call", title: "Reply", status: "pending", createdAt: ago(3 * HOUR) },
        { organisationId, kind: "content_publish", title: "Post", status: "pending", createdAt: ago(HOUR) },
        { organisationId, kind: "tool_call", title: "Old", status: "approved", createdAt: ago(10 * HOUR) },
      ]);

      const invoice = (over: Partial<typeof schema.invoices.$inferInsert>) => ({
        organisationId, clientId, number: `INV-${crypto.randomUUID().slice(0, 8)}`, dueAt: ago(HOUR), subtotalPence: 10_000, totalPence: 12_000, ...over,
      });
      await db.insert(schema.invoices).values([
        invoice({ status: "overdue" }),
        invoice({ status: "sent", totalPence: 30_000 }),
        invoice({ status: "paid", paidAt: ago(2 * HOUR), totalPence: 24_000 }),
        invoice({ status: "paid", paidAt: ago(40 * HOUR) }),
        invoice({ status: "draft" }),
      ]);

      const item = (over: Partial<typeof schema.contentItems.$inferInsert>) => ({
        organisationId, clientId, channel: "facebook" as const, kind: "social_post" as const, periodKey: "2026-09", ...over,
      });
      await db.insert(schema.contentItems).values([
        item({ status: "published", publishedAt: ago(HOUR) }),
        item({ status: "published", publishedAt: ago(30 * HOUR) }),
        item({ status: "failed", updatedAt: ago(HOUR) }),
        item({ status: "awaiting_approval" }),
      ]);

      await db.insert(schema.agentRuns).values([
        { organisationId, agentKey: "support-triage", trigger: "event", status: "completed", startedAt: ago(HOUR) },
        { organisationId, agentKey: "support-triage", trigger: "event", status: "failed", startedAt: ago(2 * HOUR), error: "refusal" },
        { organisationId, agentKey: "support-triage", trigger: "event", status: "awaiting_approval", startedAt: ago(40 * HOUR) },
      ]);

      await db.insert(schema.timeEntries).values([
        { organisationId, userId: samId, startedAt: ago(9 * HOUR), endedAt: ago(HOUR) },
        { organisationId, userId: ownerUserId, startedAt: ago(30 * 60_000), endedAt: null },
        { organisationId, userId: ownerUserId, startedAt: ago(30 * HOUR), endedAt: ago(22 * HOUR) },
      ]);

      const s = await opsMetricsSnapshot(db, organisationId, { hours: 24, now: NOW });
      expect(s.window).toEqual({ from: ago(24 * HOUR), to: NOW, hours: 24 });
      expect(s.cases).toEqual({
        opened: 2, resolved: 1, open: 3, awaitingFirstResponse: 1, breachedSla: 1, escalatedOpen: 1, medianFirstResponseMinutes: 60,
      });
      expect(s.tasks).toEqual({ open: 2, overdue: 1, completed: 1 });
      expect(s.incidents).toEqual({ open: 1, opened: 2, resolved: 1 });
      expect(s.approvals).toEqual({ pending: 2, oldestPendingHours: 3 });
      expect(s.invoices).toEqual({
        overdue: { count: 1, totalPence: 12_000 },
        outstanding: { count: 2, totalPence: 42_000 },
        paid: { count: 1, totalPence: 24_000 },
      });
      expect(s.content).toEqual({ published: 1, failed: 1, awaitingApproval: 1 });
      expect(s.agents).toEqual({ runs: 2, failed: 1, awaitingApproval: 1 });
      expect(s.team.hoursClocked).toBe(8.5);
      expect(s.team.clockedInNow).toBe(1);
      expect(s.team.byMember.map((m) => [m.name, m.hours]).sort()).toEqual([["Owner", 0.5], ["Sam", 8]]);

      const theirs = await opsMetricsSnapshot(db, other.organisationId, { now: NOW });
      expect(theirs.cases.opened).toBe(1);
      expect(theirs.cases.open).toBe(1);
      expect(theirs.invoices.outstanding.count).toBe(0);
      expect(theirs.team.byMember).toEqual([]);
    });
  });
});

describe("recentOpsActivity", () => {
  it("returns the window's timeline with client names and the audit tally, and nothing from another organisation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const other = await seedOrgWithClient(db);
      await db.insert(schema.activityEvents).values([
        { organisationId, clientId, actorKind: "user", kind: "ticket.created", title: "Case opened: Site down", link: "/cases/1", createdAt: ago(HOUR) },
        { organisationId, clientId: null, actorKind: "system", kind: "note", title: "Org-wide note", createdAt: ago(2 * HOUR) },
        { organisationId, clientId, actorKind: "user", kind: "old", title: "Last week", createdAt: ago(100 * HOUR) },
        { organisationId: other.organisationId, clientId: other.clientId, actorKind: "user", kind: "x", title: "Theirs", createdAt: ago(HOUR) },
      ]);
      await db.insert(schema.auditLog).values([
        { organisationId, actorKind: "user", action: "ticket.updated", targetType: "ticket", targetId: "a", createdAt: ago(HOUR) },
        { organisationId, actorKind: "user", action: "ticket.updated", targetType: "ticket", targetId: "b", createdAt: ago(2 * HOUR) },
        { organisationId, actorKind: "agent", action: "task.created", targetType: "task", targetId: "c", createdAt: ago(3 * HOUR) },
        { organisationId, actorKind: "agent", action: "task.created", targetType: "task", targetId: "d", createdAt: ago(60 * HOUR) },
      ]);

      const a = await recentOpsActivity(db, organisationId, { hours: 24, now: NOW });
      expect(a.timeline.map((t) => t.title)).toEqual(["Case opened: Site down", "Org-wide note"]);
      expect(a.timeline[0]).toMatchObject({ clientName: "Grays CabLine", link: "/cases/1", actorKind: "user" });
      expect(a.timeline[1]!.clientName).toBeNull();
      expect(a.auditCounts).toEqual([{ action: "ticket.updated", count: 2 }, { action: "task.created", count: 1 }]);

      const b = await recentOpsActivity(db, other.organisationId, { hours: 24, now: NOW });
      expect(b.timeline.map((t) => t.title)).toEqual(["Theirs"]);
      expect(b.auditCounts).toEqual([]);
    });
  });
});
