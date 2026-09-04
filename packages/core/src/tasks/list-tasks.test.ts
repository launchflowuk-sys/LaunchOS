import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { listTasks } from "./list-tasks.js";

describe("listTasks", () => {
  it("filters by client, status, phase, kind, assignee and due range", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Aaliyan");

      const early = await createTask(db, organisationId, { clientId, title: "Discovery call", kind: "other", phase: "onboarding", dueAt: new Date("2026-10-02T09:00:00.000Z"), assigneeUserId: staffId });
      const late = await createTask(db, organisationId, { clientId, title: "Social post 1/4", kind: "social", phase: "recurring", dueAt: new Date("2026-10-25T09:00:00.000Z"), clientVisible: false });
      await createTask(db, organisationId, { clientId, title: "No due date", kind: "other", phase: "support" });

      expect((await listTasks(db, organisationId, { clientId })).map((t) => t.id)).toEqual([early.id, late.id, expect.any(String)]);
      expect((await listTasks(db, organisationId, { phase: "recurring" })).map((t) => t.id)).toEqual([late.id]);
      expect((await listTasks(db, organisationId, { kind: "social" })).map((t) => t.id)).toEqual([late.id]);
      expect((await listTasks(db, organisationId, { assigneeUserId: staffId })).map((t) => t.id)).toEqual([early.id]);
      expect((await listTasks(db, organisationId, { assigneeUserId: "unassigned" })).map((t) => t.id)).toContain(late.id);
      expect((await listTasks(db, organisationId, { status: ["todo"] })).length).toBe(3);
      expect((await listTasks(db, organisationId, { status: ["done"] })).length).toBe(0);
      expect((await listTasks(db, organisationId, { clientVisible: true })).map((t) => t.id)).not.toContain(late.id);
      expect((await listTasks(db, organisationId, {
        dueFrom: new Date("2026-10-20T00:00:00.000Z"), dueTo: new Date("2026-10-31T00:00:00.000Z"),
      })).map((t) => t.id)).toEqual([late.id]);

      const rows = await listTasks(db, organisationId, { clientId, limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clientName).toBe("Grays CabLine");
      expect(rows[0]!.assigneeName).toBe("Aaliyan");
    });
  });

  it("never returns another organisation's tasks", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await createTask(db, a.organisationId, { clientId: a.clientId, title: "Theirs", kind: "other", phase: "support" });
      expect(await listTasks(db, b.organisationId, {})).toEqual([]);
    });
  });
});
