import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { assignTask } from "./assign-task.js";
import { findOwnerUserId, pickLeastLoadedStaff } from "./assignee.js";

describe("assignment", () => {
  it("picks the member carrying the fewest unfinished tasks", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      expect(await findOwnerUserId(db, organisationId)).toBe(ownerUserId);

      const busy = await addStaffMember(db, organisationId, "Busy");
      const quiet = await addStaffMember(db, organisationId, "Quiet");
      for (const title of ["A", "B", "C"]) {
        await createTask(db, organisationId, { clientId, title, kind: "other", phase: "support", assigneeUserId: busy });
      }
      await createTask(db, organisationId, { clientId, title: "D", kind: "other", phase: "support", assigneeUserId: ownerUserId });
      // Finished work does not count against anyone.
      const done = await createTask(db, organisationId, { clientId, title: "E", kind: "other", phase: "support", assigneeUserId: quiet, status: "done" });
      expect(done.assigneeUserId).toBe(quiet);

      expect(await pickLeastLoadedStaff(db, organisationId)).toBe(quiet);
    });
  });

  it("assigns and unassigns, rejecting a user who is not a member", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const other = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const task = await createTask(db, organisationId, { clientId, title: "SEO setup", kind: "seo", phase: "onboarding" });

      expect((await assignTask(db, organisationId, { taskId: task.id, assigneeUserId: staffId })).assigneeUserId).toBe(staffId);
      expect((await assignTask(db, organisationId, { taskId: task.id, assigneeUserId: null })).assigneeUserId).toBeNull();
      await expect(assignTask(db, organisationId, { taskId: task.id, assigneeUserId: other.ownerUserId })).rejects.toThrow(/not found in organisation/);
    });
  });
});
