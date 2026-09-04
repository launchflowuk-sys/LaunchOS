import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { updatePackage } from "../packages/update-package.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { generateRecurringTasks, quantityFor } from "./generate-recurring-tasks.js";
import { listTasks } from "./list-tasks.js";

const NOW = new Date("2026-10-14T06:00:00.000Z");

describe("quantityFor", () => {
  const includes = { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 };
  it("reads monthly quantities from the package and gates SEO", () => {
    expect(quantityFor("social", "monthly", includes)).toBe(4);
    expect(quantityFor("content", "monthly", includes)).toBe(1);
    expect(quantityFor("gbp", "monthly", includes)).toBe(2);
    expect(quantityFor("seo", "quarterly", includes)).toBe(1);
    expect(quantityFor("seo", "quarterly", { ...includes, seo: false })).toBe(0);
    expect(quantityFor("social", "quarterly", includes)).toBe(1);
    expect(quantityFor("other", "monthly", includes)).toBe(1);
  });
});

describe("generateRecurringTasks", () => {
  it("creates the package quantity once per period and never twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly", sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly", sortOrder: 20 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "seo", title: "SEO audit", recurrence: "quarterly", sortOrder: 30 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "review", title: "Never generated", recurrence: "none", sortOrder: 40 });

      const first = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(first).toEqual({ created: 6, skipped: 0 }); // 4 social + 1 blog + 1 SEO audit

      const rows = await listTasks(db, organisationId, { clientId, phase: "recurring" });
      expect(rows).toHaveLength(6);
      const keys = (await db.select().from(schema.tasks).where(eq(schema.tasks.clientId, clientId))).map((t) => t.recurrenceKey);
      expect(keys).toContain("social:2026-10:1");
      expect(keys).toContain("social:2026-10:4");
      expect(keys).toContain("content:2026-10:1");
      expect(keys).toContain("seo:2026-Q4:1");
      expect(rows.find((r) => r.title === "Social post 1/4")).toBeDefined();
      expect(rows.find((r) => r.title === "Blog post")).toBeDefined();

      const second = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(second).toEqual({ created: 0, skipped: 6 });
      expect(await listTasks(db, organisationId, { clientId, phase: "recurring" })).toHaveLength(6);

      // The next month is a new period.
      const next = await generateRecurringTasks(db, organisationId, { now: new Date("2026-11-03T06:00:00.000Z") });
      expect(next.created).toBe(5); // the quarterly SEO audit is still in Q4
    });
  });

  it("skips clients without a package, paused clients and inactive packages", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      await db.insert(schema.clients).values({ organisationId, name: "No package", slug: `np-${crypto.randomUUID()}` });

      await db.update(schema.clients).set({ status: "paused" }).where(eq(schema.clients.id, clientId));
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 0, skipped: 0 });

      await db.update(schema.clients).set({ status: "active" }).where(eq(schema.clients.id, clientId));
      await updatePackage(db, organisationId, { packageId, active: false });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 0, skipped: 0 });

      await updatePackage(db, organisationId, { packageId, active: true });
      expect(await generateRecurringTasks(db, organisationId, { now: NOW })).toEqual({ created: 1, skipped: 0 });
    });
  });

  it("absorbs a duplicate-key race and reports the skip instead of throwing", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });

      // Simulate a concurrent worker that already claimed this period's slot
      // by inserting it directly — bypassing both `createTask` and this
      // call's own pre-check — the same way a second worker racing this run
      // would land its insert first.
      await db.insert(schema.tasks).values({
        organisationId, clientId, phase: "recurring", kind: "content", title: "Blog post",
        recurrenceKey: "content:2026-10:1",
      });

      const result = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(result).toEqual({ created: 0, skipped: 1 });
      expect(await listTasks(db, organisationId, { clientId, phase: "recurring" })).toHaveLength(1);
    });
  });

  it("does not let one client's inactive package stop the next client's generation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId: clientA, packageId: packageA } = await seedOrgWithClient(db);
      const [packageB] = await db.insert(schema.packages).values({
        organisationId, name: "Package B", slug: `pkg-b-${crypto.randomUUID()}`,
        includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 0 },
      }).returning();
      const [clientB] = await db.insert(schema.clients).values({
        organisationId, name: "Client B", slug: `client-b-${crypto.randomUUID()}`, packageId: packageB!.id,
      }).returning();

      await createTaskTemplate(db, organisationId, { phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly" });
      await updatePackage(db, organisationId, { packageId: packageA, active: false });

      const result = await generateRecurringTasks(db, organisationId, { now: NOW });
      expect(result).toEqual({ created: 1, skipped: 0 });
      expect(await listTasks(db, organisationId, { clientId: clientA, phase: "recurring" })).toHaveLength(0);
      expect(await listTasks(db, organisationId, { clientId: clientB!.id, phase: "recurring" })).toHaveLength(1);
    });
  });

  it("isolates one client's real failure so the next client's tasks are still created, then rethrows an aggregate error", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId: clientA, packageId: packageA } = await seedOrgWithClient(db);
      const [packageB] = await db.insert(schema.packages).values({
        organisationId, name: "Package B", slug: `pkg-b-${crypto.randomUUID()}`,
        includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 0 },
      }).returning();
      const [clientB] = await db.insert(schema.clients).values({
        organisationId, name: "Client B", slug: `client-b-${crypto.randomUUID()}`, packageId: packageB!.id,
      }).returning();

      const brokenTemplate = await createTaskTemplate(db, organisationId, { packageId: packageA, phase: "recurring", kind: "content", title: "Blog post A", recurrence: "monthly" });
      await createTaskTemplate(db, organisationId, { packageId: packageB!.id, phase: "recurring", kind: "content", title: "Blog post B", recurrence: "monthly" });

      // Corrupt client A's template beyond `createTask`'s own validation
      // limit, bypassing `createTaskTemplate`'s check, to force a genuine
      // (non-Postgres, non-precheck) failure while the generator processes
      // client A — client B, on a different package, must still get its task.
      await db.update(schema.taskTemplates).set({ title: "x".repeat(300) }).where(eq(schema.taskTemplates.id, brokenTemplate.id));

      await expect(generateRecurringTasks(db, organisationId, { now: NOW })).rejects.toThrow(/1 of 2 client/);

      expect(await listTasks(db, organisationId, { clientId: clientA, phase: "recurring" })).toHaveLength(0);
      expect(await listTasks(db, organisationId, { clientId: clientB!.id, phase: "recurring" })).toHaveLength(1);
    });
  });
});
