import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { addStaffMember, seedOrgWithClient } from "./test-fixtures.js";
import { generateOnboardingTasks } from "./generate-onboarding-tasks.js";
import { listTasks } from "./list-tasks.js";

describe("generateOnboardingTasks", () => {
  it("creates one task per matching template, dated from the client, assigned by role", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId, ownerUserId } = await seedOrgWithClient(db);
      const staffId = await addStaffMember(db, organisationId, "Shayan");
      const [otherPkg] = await db.insert(schema.packages)
        .values({ organisationId, name: "Other", slug: `other-${crypto.randomUUID()}` }).returning();

      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "other", title: "Discovery call", offsetDays: 1, sortOrder: 10, defaultAssigneeRole: "owner" });
      await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "SEO setup", offsetDays: 20, sortOrder: 20, defaultAssigneeRole: "staff", checklist: ["Sitemap", "GSC"] });
      await createTaskTemplate(db, organisationId, { packageId: otherPkg!.id, phase: "onboarding", kind: "build", title: "Not this package", sortOrder: 30 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly" });

      const first = await generateOnboardingTasks(db, organisationId, clientId);
      expect(first.created.map((t) => t.title)).toEqual(["Discovery call", "SEO setup"]);
      expect(first.skipped).toBe(0);
      expect(first.created[0]!.assigneeUserId).toBe(ownerUserId);
      expect(first.created[1]!.assigneeUserId).toBe(staffId);
      expect(first.created[1]!.checklist).toEqual([{ label: "Sitemap", done: false }, { label: "GSC", done: false }]);
      expect(first.created[1]!.phase).toBe("onboarding");

      const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
      expect(first.created[0]!.dueAt!.getTime()).toBe(client!.createdAt.getTime() + 86_400_000);

      // Idempotent: a second run adds nothing.
      const second = await generateOnboardingTasks(db, organisationId, clientId);
      expect(second.created).toEqual([]);
      expect(second.skipped).toBe(2);
      expect(await listTasks(db, organisationId, { clientId, phase: "onboarding" })).toHaveLength(2);

      // A template added later is topped up on the next run.
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "handover", title: "Handover", offsetDays: 28, sortOrder: 40 });
      const third = await generateOnboardingTasks(db, organisationId, clientId);
      expect(third.created.map((t) => t.title)).toEqual(["Handover"]);
      expect(third.created[0]!.assigneeUserId).toBeNull();
    });
  });

  it("uses only global templates when the client has no package", async () => {
    await withTestDb(async (db) => {
      const { organisationId, packageId } = await seedOrgWithClient(db);
      const [client] = await db.insert(schema.clients)
        .values({ organisationId, name: "No package", slug: `np-${crypto.randomUUID()}` }).returning();
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "other", title: "Global", sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "onboarding", kind: "seo", title: "Package only", sortOrder: 20 });

      const result = await generateOnboardingTasks(db, organisationId, client!.id);
      expect(result.created.map((t) => t.title)).toEqual(["Global"]);
      const activity = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.clientId, client!.id), eq(schema.activityEvents.kind, "tasks.onboarding_generated")));
      expect(activity).toHaveLength(1);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(generateOnboardingTasks(db, b.organisationId, a.clientId)).rejects.toThrow(/not found in organisation/);
    });
  });
});
