import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateOrganisation } from "./update-organisation.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("updateOrganisation", () => {
  it("saves the supplier details an invoice needs and audits the change", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const updated = await updateOrganisation(db, org.id, {
        legalName: "LaunchFlow Ltd",
        addressLine1: "1 High Street",
        city: "Grays",
        postcode: "RM17 6AA",
        country: "GB",
        vatNumber: "GB123456789",
        companyNumber: "12345678",
        invoiceFooter: "Bank: 00-00-00 / 12345678",
        actorKind: "user",
        actorId: "u1",
      });

      expect(updated.legalName).toBe("LaunchFlow Ltd");
      expect(updated.vatNumber).toBe("GB123456789");
      // The tenant key and the display name are not patchable here.
      expect(updated.slug).toBe(org.slug);
      expect(updated.name).toBe("T");

      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, org.id));
      expect(audit.map((row) => row.action)).toEqual(["organisation.updated"]);
      expect(audit[0]!.actorId).toBe("u1");
    });
  });

  it("clears a field when it is emptied, so a de-registered supplier can drop its VAT number", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await updateOrganisation(db, org.id, { vatNumber: "GB123456789", actorKind: "system" });

      const cleared = await updateOrganisation(db, org.id, { vatNumber: null, actorKind: "system" });
      expect(cleared.vatNumber).toBeNull();
    });
  });

  it("refuses a malformed VAT number rather than printing it on every invoice", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      // Eight digits, not nine — the typo a length cap lets straight through.
      await expect(updateOrganisation(db, org.id, { vatNumber: "GB12345678" })).rejects.toThrow();
      await expect(updateOrganisation(db, org.id, { vatNumber: "VAT GB123456789" })).rejects.toThrow();
      await expect(updateOrganisation(db, org.id, { country: "United Kingdom" })).rejects.toThrow();
      await expect(updateOrganisation(db, org.id, { postcode: "RM" })).rejects.toThrow();

      const [unchanged] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, org.id));
      expect(unchanged!.vatNumber).toBeNull();
    });
  });

  it("normalises a well-formed VAT number and country rather than storing what was typed", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const updated = await updateOrganisation(db, org.id, {
        vatNumber: " gb 123 456 789 ",
        country: " gb ",
        actorKind: "system",
      });

      expect(updated.vatNumber).toBe("GB123456789");
      expect(updated.country).toBe("GB");
    });
  });

  it("refuses an organisation id that does not exist", async () => {
    await withTestDb(async (db) => {
      await expect(updateOrganisation(db, crypto.randomUUID(), { legalName: "Nobody" })).rejects.toThrow(/not found/);
    });
  });
});
