import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createTaskTemplate } from "./create-task-template.js";
import { deleteTaskTemplate, updateTaskTemplate } from "./update-task-template.js";
import { listTaskTemplates } from "./list-task-templates.js";

describe("task templates", () => {
  it("orders by sort_order, filters by phase and package, and includes global templates", async () => {
    await withTestDb(async (db) => {
      const { organisationId, packageId } = await seedOrgWithClient(db);
      const global = await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "build", title: "Build website", offsetDays: 14, sortOrder: 20 });
      const scoped = await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "SEO setup", offsetDays: 20, sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly" });

      const onboarding = await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: true });
      expect(onboarding.map((t) => t.id)).toEqual([scoped.id, global.id]);

      const scopedOnly = await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: false });
      expect(scopedOnly.map((t) => t.id)).toEqual([scoped.id]);

      const renamed = await updateTaskTemplate(db, organisationId, { templateId: global.id, title: "Build the website", sortOrder: 5 });
      expect(renamed.title).toBe("Build the website");
      expect(renamed.sortOrder).toBe(5);

      expect(await deleteTaskTemplate(db, organisationId, { templateId: global.id })).toEqual({ deleted: true });
      expect((await listTaskTemplates(db, organisationId, { phase: "onboarding", packageId, includeGlobal: true })).map((t) => t.id)).toEqual([scoped.id]);
    });
  });

  it("refuses a template from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const t = await createTaskTemplate(db, a.organisationId, { phase: "onboarding", kind: "build", title: "Build" });
      await expect(updateTaskTemplate(db, b.organisationId, { templateId: t.id, title: "Hijack" })).rejects.toThrow();
      expect(await deleteTaskTemplate(db, b.organisationId, { templateId: t.id })).toEqual({ deleted: false });
    });
  });
});
