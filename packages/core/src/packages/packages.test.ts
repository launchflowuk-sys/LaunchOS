import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createPackage } from "./create-package.js";
import { updatePackage } from "./update-package.js";
import { getPackage, listPackages } from "./list-packages.js";

describe("packages", () => {
  it("creates, lists, updates and archives a package and audits every write", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const created = await createPackage(db, organisationId, {
        name: "Website Care", slug: `care-${randomUUID()}`, monthlyPricePence: 9900,
        includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
      });
      expect(created.currency).toBe("GBP");
      expect(created.includes.blogPostsPerMonth).toBe(1);

      const updated = await updatePackage(db, organisationId, { packageId: created.id, monthlyPricePence: 12900 });
      expect(updated.monthlyPricePence).toBe(12900);

      expect((await listPackages(db, organisationId, { activeOnly: true })).map((p) => p.id)).toContain(created.id);
      await updatePackage(db, organisationId, { packageId: created.id, active: false });
      expect((await listPackages(db, organisationId, { activeOnly: true })).map((p) => p.id)).not.toContain(created.id);
      expect((await getPackage(db, organisationId, created.id))?.active).toBe(false);

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, created.id));
      expect(audits.map((a) => a.action)).toEqual(["package.created", "package.updated", "package.updated"]);
    });
  });

  it("sets and clears the Stripe price id without touching the rest", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const created = await createPackage(db, organisationId, { name: "Care", slug: `care-${randomUUID()}`, monthlyPricePence: 4900 });
      expect(created.stripePriceId).toBeNull();

      const priced = await updatePackage(db, organisationId, { packageId: created.id, stripePriceId: "price_123" });
      expect(priced.stripePriceId).toBe("price_123");
      expect(priced.monthlyPricePence).toBe(4900);

      // An update that says nothing about the price id leaves it alone.
      const renamed = await updatePackage(db, organisationId, { packageId: created.id, name: "Care Plus" });
      expect(renamed.stripePriceId).toBe("price_123");

      const cleared = await updatePackage(db, organisationId, { packageId: created.id, stripePriceId: null });
      expect(cleared.stripePriceId).toBeNull();
      await expect(updatePackage(db, organisationId, { packageId: created.id, stripePriceId: "" })).rejects.toThrow();
    });
  });

  it("refuses a package from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(updatePackage(db, b.organisationId, { packageId: a.packageId, active: false })).rejects.toThrow();
      expect(await getPackage(db, b.organisationId, a.packageId)).toBeNull();
    });
  });
});
