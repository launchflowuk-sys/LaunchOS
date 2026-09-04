import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { updateTaskStatus } from "./update-task-status.js";
import { findOverdueTasks, notifyOverdueTasks } from "./find-overdue-tasks.js";

const NOW = new Date("2026-10-14T08:00:00.000Z");
const past = (iso: string) => new Date(iso);

describe("overdue tasks", () => {
  it("finds only unfinished tasks past their due date", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const late = await createTask(db, organisationId, { clientId, title: "Late", kind: "other", phase: "support", dueAt: past("2026-10-10T09:00:00.000Z") });
      await createTask(db, organisationId, { clientId, title: "Future", kind: "other", phase: "support", dueAt: past("2026-10-20T09:00:00.000Z") });
      await createTask(db, organisationId, { clientId, title: "Undated", kind: "other", phase: "support" });
      const finished = await createTask(db, organisationId, { clientId, title: "Finished", kind: "other", phase: "support", dueAt: past("2026-10-01T09:00:00.000Z") });
      await updateTaskStatus(db, organisationId, { taskId: finished.id, status: "done" });

      expect((await findOverdueTasks(db, organisationId, { now: NOW })).map((t) => t.id)).toEqual([late.id]);
    });
  });

  it("notifies owner and assignee once a day and emits task.overdue", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const task = await createTask(db, organisationId, {
        clientId, title: "DNS cutover", kind: "dns", phase: "onboarding",
        dueAt: past("2026-10-10T09:00:00.000Z"), assigneeUserId: staffId,
      });

      expect(await notifyOverdueTasks(db, organisationId, { now: NOW })).toEqual({ overdue: 1, notified: 1 });
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"));
      expect(notifications.map((n) => n.userId).sort()).toEqual([ownerUserId, staffId].sort());
      expect(events.filter((e) => e.name === "task.overdue")).toEqual([{ name: "task.overdue", organisationId, taskId: task.id }]);

      // Same London day: no second notification.
      expect(await notifyOverdueTasks(db, organisationId, { now: new Date("2026-10-14T20:00:00.000Z") })).toEqual({ overdue: 1, notified: 0 });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"))).toHaveLength(2);

      // Next day: chased again.
      expect(await notifyOverdueTasks(db, organisationId, { now: new Date("2026-10-15T08:00:00.000Z") })).toEqual({ overdue: 1, notified: 1 });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "task.overdue"))).toHaveLength(4);

      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
      expect((row!.metadata as { lastOverdueNotifiedOn?: string }).lastOverdueNotifiedOn).toBe("2026-10-15");
      setEnqueue(async () => {});
    });
  });
});
