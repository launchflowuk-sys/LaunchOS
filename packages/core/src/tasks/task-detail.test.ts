import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { getTask } from "./get-task.js";
import { commentOnTask } from "./comment-on-task.js";
import { setTaskVisibility, toggleChecklistItem } from "./toggle-checklist-item.js";

describe("task detail writes", () => {
  it("appends comments, toggles checklist items immutably and flips client visibility", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const task = await createTask(db, organisationId, {
        clientId, title: "Content collection", kind: "content", phase: "onboarding",
        checklist: [{ label: "Logo" }, { label: "Photos" }, { label: "Copy" }],
      });

      await commentOnTask(db, organisationId, { taskId: task.id, bodyMd: "Chased the client", authorKind: "user", authorId: ownerUserId });
      await commentOnTask(db, organisationId, { taskId: task.id, bodyMd: "Photos received", authorKind: "user", authorId: ownerUserId });
      const loaded = await getTask(db, organisationId, task.id);
      expect(loaded?.comments.map((c) => c.bodyMd)).toEqual(["Chased the client", "Photos received"]);

      const toggled = await toggleChecklistItem(db, organisationId, { taskId: task.id, index: 1, done: true });
      expect(toggled.checklist).toEqual([{ label: "Logo", done: false }, { label: "Photos", done: true }, { label: "Copy", done: false }]);
      expect(task.checklist[1]!.done).toBe(false); // the original object was not mutated

      await expect(toggleChecklistItem(db, organisationId, { taskId: task.id, index: 9, done: true })).rejects.toThrow(/checklist index/);

      expect((await setTaskVisibility(db, organisationId, { taskId: task.id, clientVisible: false })).clientVisible).toBe(false);
    });
  });
});
