import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { addStaffMember, seedOrgWithClient } from "../tasks/test-fixtures.js";
import { clockIn, clockOut, getRunningEntry, startTimer, stopTimer } from "./time-entries.js";
import { listTimesheet, teamTimesheets } from "./timesheets.js";
import { addCalendarDays, entryMinutes, formatMinutes, mondayOf, weekBounds } from "./week.js";

// A Wednesday in British Summer Time: London midnight is 23:00 UTC the day before.
const WED = new Date("2026-09-09T10:00:00Z");

async function aTask(db: Parameters<typeof clockIn>[0], organisationId: string, clientId: string, title = "Fix the header") {
  const [task] = await db.insert(schema.tasks).values({ organisationId, clientId, phase: "support", title }).returning();
  return task!;
}

describe("week helpers", () => {
  it("snaps to Monday, bounds the week in London time, and counts minutes", () => {
    expect(mondayOf("2026-09-09")).toBe("2026-09-07");
    expect(mondayOf("2026-09-07")).toBe("2026-09-07");
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");
    expect(addCalendarDays("2026-09-30", 1)).toBe("2026-10-01");
    const week = weekBounds("2026-09-09");
    expect(week.weekStart).toBe("2026-09-07");
    expect(week.weekEnd).toBe("2026-09-14");
    expect(week.days).toHaveLength(7);
    expect(week.start.toISOString()).toBe("2026-09-06T23:00:00.000Z");
    expect(week.end.toISOString()).toBe("2026-09-13T23:00:00.000Z");
    // In winter London midnight is UTC midnight.
    expect(weekBounds("2026-12-02").start.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(entryMinutes({ startedAt: new Date("2026-09-09T09:00:00Z"), endedAt: new Date("2026-09-09T10:30:30Z") }, WED)).toBe(90);
    expect(entryMinutes({ startedAt: new Date("2026-09-09T09:00:00Z"), endedAt: null }, WED)).toBe(60);
    expect(entryMinutes({ startedAt: new Date("2026-09-09T11:00:00Z"), endedAt: null }, WED)).toBe(0);
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(455)).toBe("7h 35m");
  });
});

describe("clockIn / clockOut", () => {
  it("opens one running entry, is idempotent while running, closes it, and audits both ends", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      expect(await getRunningEntry(db, organisationId, { userId: ownerUserId })).toBeNull();
      expect(await clockOut(db, organisationId, { userId: ownerUserId, now: WED })).toBeNull();

      const first = await clockIn(db, organisationId, { userId: ownerUserId, now: WED, note: "Morning" });
      expect(first.started).toBe(true);
      expect(first.entry.endedAt).toBeNull();
      expect(first.entry.note).toBe("Morning");

      const again = await clockIn(db, organisationId, { userId: ownerUserId, now: new Date(WED.getTime() + 60_000) });
      expect(again.started).toBe(false);
      expect(again.entry.id).toBe(first.entry.id);
      expect(await getRunningEntry(db, organisationId, { userId: ownerUserId })).toMatchObject({ id: first.entry.id });

      const later = new Date(WED.getTime() + 2 * 3_600_000);
      const closed = await clockOut(db, organisationId, { userId: ownerUserId, now: later });
      expect(closed?.id).toBe(first.entry.id);
      expect(closed?.endedAt?.toISOString()).toBe(later.toISOString());
      expect(await getRunningEntry(db, organisationId, { userId: ownerUserId })).toBeNull();

      const actions = (await db.select({ action: schema.auditLog.action, targetId: schema.auditLog.targetId }).from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetType, "time_entry"))))
        .map((a) => a.action).sort();
      expect(actions).toEqual(["time_entry.started", "time_entry.stopped"]);
    });
  });

  it("refuses a stranger and keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(clockIn(db, a.organisationId, { userId: b.ownerUserId, now: WED })).rejects.toThrow(/not found in organisation/);
      await clockIn(db, a.organisationId, { userId: a.ownerUserId, now: WED });
      // The same person's running entry in A is invisible from B, and B cannot close it.
      expect(await getRunningEntry(db, b.organisationId, { userId: a.ownerUserId })).toBeNull();
      await expect(clockOut(db, b.organisationId, { userId: a.ownerUserId, now: WED })).rejects.toThrow(/not found in organisation/);
      expect(await getRunningEntry(db, a.organisationId, { userId: a.ownerUserId })).not.toBeNull();
    });
  });
});

describe("startTimer / stopTimer", () => {
  it("switches from a clock-in to a task timer, keeping exactly one entry running, and refuses another organisation's task", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const other = await seedOrgWithClient(db);
      const task = await aTask(db, organisationId, clientId);
      const foreignTask = await aTask(db, other.organisationId, other.clientId, "Not yours");

      await clockIn(db, organisationId, { userId: ownerUserId, now: WED });
      const t1 = new Date(WED.getTime() + 30 * 60_000);
      const started = await startTimer(db, organisationId, { userId: ownerUserId, taskId: task.id, now: t1, note: "Header" });
      expect(started.switchedFrom?.endedAt?.toISOString()).toBe(t1.toISOString());
      expect(started.entry.taskId).toBe(task.id);
      expect(started.entry.startedAt.toISOString()).toBe(t1.toISOString());

      const running = await db.select().from(schema.timeEntries)
        .where(and(eq(schema.timeEntries.organisationId, organisationId), eq(schema.timeEntries.userId, ownerUserId)));
      expect(running.filter((e) => e.endedAt === null)).toHaveLength(1);

      await expect(startTimer(db, organisationId, { userId: ownerUserId, taskId: foreignTask.id, now: t1 }))
        .rejects.toThrow(/task .* not found in organisation/);
      await expect(startTimer(db, organisationId, { userId: ownerUserId, taskId: task.id, ticketId: task.id, now: t1 }))
        .rejects.toThrow(/not both/);

      const t2 = new Date(t1.getTime() + 45 * 60_000);
      const stopped = await stopTimer(db, organisationId, { userId: ownerUserId, now: t2 });
      expect(stopped?.id).toBe(started.entry.id);
      expect(await getRunningEntry(db, organisationId, { userId: ownerUserId })).toBeNull();
    });
  });
});

describe("timesheets", () => {
  it("buckets a member's entries by London day with per-day and week totals, counting a running entry to now", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const staffUserId = await addStaffMember(db, organisationId, "Sam");
      const task = await aTask(db, organisationId, clientId);

      // Monday 08:00–10:00 London (07:00–09:00 UTC in BST).
      await db.insert(schema.timeEntries).values([
        { organisationId, userId: ownerUserId, startedAt: new Date("2026-09-07T07:00:00Z"), endedAt: new Date("2026-09-07T09:00:00Z") },
        // Tuesday 23:30 London = 22:30 UTC — still Tuesday in London, Tuesday's bucket.
        { organisationId, userId: ownerUserId, startedAt: new Date("2026-09-08T22:30:00Z"), endedAt: new Date("2026-09-08T23:15:00Z"), taskId: task.id },
        // Wednesday, running: counted to `now` (10:00 UTC) = 60 minutes.
        { organisationId, userId: ownerUserId, startedAt: new Date("2026-09-09T09:00:00Z"), endedAt: null, note: "Live" },
        // Last week: outside the window.
        { organisationId, userId: ownerUserId, startedAt: new Date("2026-09-04T09:00:00Z"), endedAt: new Date("2026-09-04T10:00:00Z") },
        // Somebody else, same week.
        { organisationId, userId: staffUserId, startedAt: new Date("2026-09-10T08:00:00Z"), endedAt: new Date("2026-09-10T11:30:00Z") },
      ]);

      const sheet = await listTimesheet(db, organisationId, { userId: ownerUserId, weekStart: "2026-09-09", now: WED });
      expect(sheet.weekStart).toBe("2026-09-07");
      expect(sheet.days.map((d) => d.date)).toEqual(["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
      expect(sheet.days.map((d) => d.minutes)).toEqual([120, 45, 60, 0, 0, 0, 0]);
      expect(sheet.totalMinutes).toBe(225);
      expect(sheet.days[1]!.entries[0]).toMatchObject({ taskId: task.id, taskTitle: "Fix the header", running: false });
      expect(sheet.days[2]!.entries[0]).toMatchObject({ running: true, note: "Live", minutes: 60 });

      const team = await teamTimesheets(db, organisationId, { weekStart: "2026-09-07", now: WED });
      expect(team.days).toEqual(sheet.days.map((d) => d.date));
      expect(team.members.map((m) => [m.name, m.totalMinutes, m.running])).toEqual([["Owner", 225, true], ["Sam", 210, false]]);
      expect(team.members[1]!.dayMinutes).toEqual([0, 0, 0, 210, 0, 0, 0]);
      expect(team.totalMinutes).toBe(435);

      // Another organisation sees none of it.
      const other = await seedOrgWithClient(db);
      const foreign = await teamTimesheets(db, other.organisationId, { weekStart: "2026-09-07", now: WED });
      expect(foreign.totalMinutes).toBe(0);
      expect(foreign.members).toHaveLength(1);
    });
  });
});
