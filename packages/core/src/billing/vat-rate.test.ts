import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { describe, expect, it } from "vitest";
import { isVatRegistered, vatRateForOrganisation, VAT_RATE_DEFAULT_PERCENT } from "./vat-rate.js";

async function organisation(db: Db, vatNumber: string | null) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `vat-${randomUUID()}`, vatNumber })
    .returning();
  return org!;
}

describe("isVatRegistered", () => {
  it("treats a missing or blank number as unregistered", () => {
    expect(isVatRegistered(null)).toBe(false);
    expect(isVatRegistered(undefined)).toBe(false);
    expect(isVatRegistered("")).toBe(false);
    expect(isVatRegistered("   ")).toBe(false);
    expect(isVatRegistered("GB123456789")).toBe(true);
  });
});

describe("vatRateForOrganisation", () => {
  it("zero-rates an organisation with no VAT number, whatever VAT_RATE says", async () => {
    await withTestDb(async (db) => {
      const org = await organisation(db, null);
      expect(await vatRateForOrganisation(db, org.id, { VAT_RATE: "20" } as NodeJS.ProcessEnv)).toBe(0);
    });
  });

  it("charges the configured rate once the organisation is registered", async () => {
    await withTestDb(async (db) => {
      const org = await organisation(db, "GB123456789");
      expect(await vatRateForOrganisation(db, org.id, { VAT_RATE: "20" } as NodeJS.ProcessEnv)).toBe(20);
      expect(await vatRateForOrganisation(db, org.id, { VAT_RATE: "5" } as NodeJS.ProcessEnv)).toBe(5);
    });
  });

  it("falls back to the UK standard rate when VAT_RATE is absent, blank or junk", async () => {
    await withTestDb(async (db) => {
      const org = await organisation(db, "GB123456789");
      expect(await vatRateForOrganisation(db, org.id, {} as NodeJS.ProcessEnv)).toBe(VAT_RATE_DEFAULT_PERCENT);
      expect(await vatRateForOrganisation(db, org.id, { VAT_RATE: "  " } as NodeJS.ProcessEnv)).toBe(VAT_RATE_DEFAULT_PERCENT);
      expect(await vatRateForOrganisation(db, org.id, { VAT_RATE: "nope" } as NodeJS.ProcessEnv)).toBe(VAT_RATE_DEFAULT_PERCENT);
    });
  });

  it("refuses an organisation id that does not exist", async () => {
    await withTestDb(async (db) => {
      await expect(vatRateForOrganisation(db, randomUUID())).rejects.toThrow(/not found/);
    });
  });
});
