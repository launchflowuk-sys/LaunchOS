import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { listTasks } from "./list-tasks.js";

const setCreatedAt = (db: Db, id: string, iso: string) =>
  db.update(schema.tasks).set({ createdAt: new Date(iso) }).where(eq(schema.tasks.id, id));

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

  it("sort: \"recent\" puts the newest task first, ahead of dated older ones", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);

      // Due order would read dated-then-undated, so the newest row is last.
      const dated = await createTask(db, organisationId, { clientId, title: "Dated", kind: "other", phase: "onboarding", dueAt: new Date("2026-10-02T09:00:00.000Z") });
      const older = await createTask(db, organisationId, { clientId, title: "Older undated", kind: "other", phase: "support" });
      const newest = await createTask(db, organisationId, { clientId, title: "Newest", kind: "other", phase: "support" });

      // `defaultNow()` is the transaction's clock, and this whole test is one
      // transaction, so all three rows would otherwise share `created_at` and
      // the order would fall through to the random `id` tie-break.
      await setCreatedAt(db, dated.id, "2026-09-01T09:00:00.000Z");
      await setCreatedAt(db, older.id, "2026-09-02T09:00:00.000Z");
      await setCreatedAt(db, newest.id, "2026-09-03T09:00:00.000Z");

      expect((await listTasks(db, organisationId, { sort: "recent" }))[0]!.id).toBe(newest.id);
      // A one-row page still contains it, which is the point: the cross-client
      // list is capped, and a task just created must survive the cap.
      expect((await listTasks(db, organisationId, { sort: "recent", limit: 1 })).map((t) => t.id)).toEqual([newest.id]);
      // The default is unchanged: due order still leads with the dated task.
      expect((await listTasks(db, organisationId, { limit: 1 }))[0]!.title).toBe("Dated");
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
