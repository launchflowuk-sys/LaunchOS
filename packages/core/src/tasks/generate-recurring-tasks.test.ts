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
});
