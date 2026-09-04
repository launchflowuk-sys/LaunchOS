import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createTaskTemplate } from "@launchos/core";
import { randomUUID } from "node:crypto";
import { handleGenerateOnboarding, runOverdueSweep, runRecurringSweep } from "./task-generation.js";

async function world(db: Parameters<typeof handleGenerateOnboarding>[0]) {
  const [org] = await db.insert(schema.organisations).values({ name: "W", slug: `w-${randomUUID()}` }).returning();
  const [owner] = await db.insert(schema.user).values({ id: randomUUID(), name: "O", email: `o-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: org!.id, name: "Care", slug: `care-${randomUUID()}`,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 0 },
  }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}`, packageId: pkg!.id }).returning();
  return { organisationId: org!.id, clientId: client!.id, packageId: pkg!.id };
}

describe("task generation jobs", () => {
  it("generates onboarding tasks for one client and is safe to re-run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await world(db);
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "build", title: "Build website", offsetDays: 14 });
      expect(await handleGenerateOnboarding(db, { organisationId, clientId })).toEqual({ created: 1, skipped: 0 });
      expect(await handleGenerateOnboarding(db, { organisationId, clientId })).toEqual({ created: 0, skipped: 1 });
    });
  });

  it("sweeps every organisation for recurring work and overdue chases", async () => {
    await withTestDb(async (db) => {
      const a = await world(db);
      const b = await world(db);
      for (const w of [a, b]) {
        await createTaskTemplate(db, w.organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      }
      const now = new Date("2026-10-14T06:00:00.000Z");
      const recurring = await runRecurringSweep(db, now);
      expect(recurring.created).toBe(2);
      expect(recurring.organisations).toBeGreaterThanOrEqual(2);

      const overdue = await runOverdueSweep(db, new Date("2026-12-01T08:00:00.000Z"));
      expect(overdue.notified).toBe(2);
    });
  });
});
