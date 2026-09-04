import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { updateTaskStatus } from "./update-task-status.js";

async function client(db: Parameters<typeof createTask>[0], clientId: string) {
  const [row] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  return row!;
}

describe("updateTaskStatus", () => {
  it("stamps completed_at, clears it on reopen, and emits task.completed", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const task = await createTask(db, organisationId, { clientId, title: "Social post", kind: "social", phase: "recurring" });

      const done = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done", actorKind: "user", actorId: "u1" });
      expect(done.task.status).toBe("done");
      expect(done.task.completedAt).toBeInstanceOf(Date);

      const reopened = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "in_progress" });
      expect(reopened.task.completedAt).toBeNull();

      expect(events.filter((e) => e.name === "task.completed")).toEqual([{ name: "task.completed", organisationId, taskId: task.id }]);
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, task.id));
      expect(audits.map((a) => a.action)).toEqual(["task.created", "task.status_changed", "task.status_changed"]);
      setEnqueue(async () => {});
    });
  });

  it("marks the client onboarded only when every onboarding task is finished", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const a = await createTask(db, organisationId, { clientId, title: "Discovery call", kind: "other", phase: "onboarding" });
      const b = await createTask(db, organisationId, { clientId, title: "Handover", kind: "handover", phase: "onboarding" });
      const c = await createTask(db, organisationId, { clientId, title: "Nice to have", kind: "other", phase: "onboarding" });

      const first = await updateTaskStatus(db, organisationId, { taskId: a.id, status: "done" });
      expect(first.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).onboardedAt).toBeNull();

      const handover = await updateTaskStatus(db, organisationId, { taskId: b.id, status: "done" });
      expect(handover.handoverRecorded).toBe(true);
      expect(handover.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).handoverAt).toBeInstanceOf(Date);

      // Cancelling clears the task from the outstanding count but does not
      // itself trigger the sweep, so the client is not stamped yet.
      const last = await updateTaskStatus(db, organisationId, { taskId: c.id, status: "cancelled" });
      expect(last.onboardingCompleted).toBe(false);
      expect((await client(db, clientId)).onboardedAt).toBeNull();

      // Completing an already-done task re-runs the check and stamps it.
      const again = await updateTaskStatus(db, organisationId, { taskId: a.id, status: "done" });
      expect(again.onboardingCompleted).toBe(true);
      expect((await client(db, clientId)).onboardedAt).toBeInstanceOf(Date);

      // A recurring task completing later must not re-stamp or throw.
      const r = await createTask(db, organisationId, { clientId, title: "Blog post", kind: "content", phase: "recurring" });
      expect((await updateTaskStatus(db, organisationId, { taskId: r.id, status: "done" })).onboardingCompleted).toBe(false);
    });
  });

  it("refuses a task from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const t = await createTask(db, a.organisationId, { clientId: a.clientId, title: "Theirs", kind: "other", phase: "support" });
      await expect(updateTaskStatus(db, b.organisationId, { taskId: t.id, status: "done" })).rejects.toThrow(/not found in organisation/);
    });
  });
});
