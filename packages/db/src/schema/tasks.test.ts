import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "../test/db.js";
import { clients, organisations, packages, taskComments, taskTemplates, tasks } from "./index.js";

describe("task schema", () => {
  it("links package to template to task to comment and enforces both idempotency keys", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const [pkg] = await db.insert(packages).values({
        organisationId: org!.id,
        name: "Website Care",
        slug: `care-${crypto.randomUUID()}`,
        monthlyPricePence: 9900,
        includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
      }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-cabline-${crypto.randomUUID()}`, packageId: pkg!.id }).returning();
      expect(client!.onboardedAt).toBeNull();
      expect(client!.handoverAt).toBeNull();

      const [template] = await db.insert(taskTemplates).values({
        organisationId: org!.id, packageId: pkg!.id, phase: "onboarding", kind: "build",
        title: "Build website", offsetDays: 14, sortOrder: 40, checklist: ["Homepage", "Contact form"],
      }).returning();
      expect(template!.recurrence).toBe("none");
      expect(template!.defaultAssigneeRole).toBe("any");

      const [task] = await db.insert(tasks).values({
        organisationId: org!.id, clientId: client!.id, templateId: template!.id, phase: "onboarding",
        kind: "build", title: "Build website", checklist: [{ label: "Homepage", done: false }],
      }).returning();
      expect(task!.status).toBe("todo");
      expect(task!.priority).toBe("medium");
      expect(task!.clientVisible).toBe(true);
      expect(task!.completedAt).toBeNull();

      const [comment] = await db.insert(taskComments).values({
        organisationId: org!.id, taskId: task!.id, authorKind: "user", bodyMd: "Started today",
      }).returning();
      expect(comment!.taskId).toBe(task!.id);

      // A second onboarding task for the same (client, template) is rejected.
      // Wrapped in a nested transaction (drizzle issues a SAVEPOINT) so the
      // expected constraint violation doesn't abort the outer test transaction.
      await expect(
        db.transaction((tx) =>
          tx.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, templateId: template!.id, phase: "onboarding", kind: "build", title: "Build website again" }),
        ),
      ).rejects.toThrow();

      // recurrence_key is unique per client.
      await db.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "Social post 1/4", recurrenceKey: "social:2026-10:1" });
      await expect(
        db.transaction((tx) =>
          tx.insert(tasks).values({ organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "dup", recurrenceKey: "social:2026-10:1" }),
        ),
      ).rejects.toThrow();

      const rows = await db.select().from(tasks).where(eq(tasks.clientId, client!.id));
      expect(rows).toHaveLength(2);
    });
  });
});
