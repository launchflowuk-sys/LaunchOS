import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setFxRate } from "./fx.js";
import { profitReport } from "./profit.js";
import { deleteCost, listRegister, prefillRegister, unpricedCosts, upsertCost, KNOWN_SUPPLIERS } from "./register.js";

async function makeOrg(db: Db, vatNumber: string | null = "GB123456789") {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "LaunchFlow", slug: `lf-${crypto.randomUUID()}`, ...(vatNumber ? { vatNumber } : {}) })
    .returning();
  return org!;
}

const ACTOR = "user-1";

describe("upsertCost", () => {
  it("records a cost somebody typed in, as a manual row with no external id", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const row = await upsertCost(db, org.id, {
        supplier: "hetzner",
        name: "Hetzner — CX42",
        business: "shared",
        renewalPrice: 2400,
        currencyCode: "EUR",
        billingPeriodUnit: "month",
        vatTreatment: "reverse_charge",
        actorId: ACTOR,
      });

      expect(row.source).toBe("manual");
      expect(row.externalId).toBeNull();
      expect(row.business).toBe("shared");
      expect(row.vatTreatment).toBe("reverse_charge");
    });
  });

  it("audits the write, like every other business record", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await upsertCost(db, org.id, { supplier: "github", name: "GitHub", renewalPrice: 400, actorId: ACTOR });

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, row.id));
      expect(audits.map((a) => a.action)).toContain("cost.created");
    });
  });

  it("lets a person edit a manual row's money", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await upsertCost(db, org.id, { supplier: "openai", name: "OpenAI", renewalPrice: 0, actorId: ACTOR });

      const updated = await upsertCost(db, org.id, {
        id: row.id,
        supplier: "openai",
        name: "OpenAI — API",
        renewalPrice: 4500,
        currencyCode: "USD",
        actorId: ACTOR,
      });

      expect(updated.renewalPrice).toBe(4500);
      expect(updated.name).toBe("OpenAI — API");
    });
  });

  it("refuses to change a synced row's money, because the next sync would revert it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [synced] = await db
        .insert(schema.supplierCosts)
        .values({
          organisationId: org.id,
          supplier: "hostinger",
          externalId: "sub_1",
          name: ".CO.UK Domain",
          status: "active",
          renewalPrice: 1200,
          currencyCode: "USD",
          source: "sync",
        })
        .returning();

      const updated = await upsertCost(db, org.id, {
        id: synced!.id,
        supplier: "hostinger",
        name: "RENAMED",
        renewalPrice: 9999,
        business: "cabio",
        vatTreatment: "standard",
        actorId: ACTOR,
      });

      // The supplier's figures stand.
      expect(updated.renewalPrice).toBe(1200);
      expect(updated.name).toBe(".CO.UK Domain");
      // What the sync cannot know is still editable.
      expect(updated.business).toBe("cabio");
      expect(updated.vatTreatment).toBe("standard");
    });
  });
});

describe("deleteCost", () => {
  it("deletes a manual row", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await upsertCost(db, org.id, { supplier: "other", name: "Something", actorId: ACTOR });
      await deleteCost(db, org.id, row.id, ACTOR);
      expect(await listRegister(db, org.id)).toHaveLength(0);
    });
  });

  it("refuses to delete a synced row rather than letting it silently reappear", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [synced] = await db
        .insert(schema.supplierCosts)
        .values({ organisationId: org.id, supplier: "hostinger", externalId: "sub_2", name: "Domain", status: "active", source: "sync" })
        .returning();

      await expect(deleteCost(db, org.id, synced!.id, ACTOR)).rejects.toThrow(/supplier sync/i);
    });
  });
});

describe("prefillRegister", () => {
  it("seeds every supplier the code knows about, priced at zero", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const { added } = await prefillRegister(db, org.id, ACTOR);

      expect(added).toBe(KNOWN_SUPPLIERS.length);
      const rows = await listRegister(db, org.id);
      expect(rows).toHaveLength(KNOWN_SUPPLIERS.length);
      // Zero is honest: the code knows the supplier exists, not the price.
      expect(rows.every((r) => r.renewalPrice === 0)).toBe(true);
      // Mapbox belongs to Cabio and must not land on LaunchFlow's P&L.
      expect(rows.find((r) => r.supplier === "mapbox")?.business).toBe("cabio");
    });
  });

  it("is idempotent, and never touches a row somebody has already priced", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await prefillRegister(db, org.id, ACTOR);

      const before = await listRegister(db, org.id);
      const hetzner = before.find((r) => r.supplier === "hetzner")!;
      await upsertCost(db, org.id, {
        id: hetzner.id,
        supplier: "hetzner",
        name: hetzner.name,
        business: "shared",
        renewalPrice: 3600,
        currencyCode: "EUR",
        billingPeriodUnit: "month",
        vatTreatment: "reverse_charge",
        actorId: ACTOR,
      });

      const { added } = await prefillRegister(db, org.id, ACTOR);

      expect(added).toBe(0);
      const after = await listRegister(db, org.id);
      expect(after).toHaveLength(KNOWN_SUPPLIERS.length);
      expect(after.find((r) => r.supplier === "hetzner")!.renewalPrice).toBe(3600);
    });
  });
});

describe("unpricedCosts", () => {
  it("lists what still needs a number on it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await upsertCost(db, org.id, { supplier: "github", name: "GitHub", renewalPrice: 0, actorId: ACTOR });
      await upsertCost(db, org.id, { supplier: "postmark", name: "Postmark", renewalPrice: 1500, actorId: ACTOR });

      const unpriced = await unpricedCosts(db, org.id);
      expect(unpriced.map((r) => r.supplier)).toEqual(["github"]);
    });
  });
});

describe("profitReport", () => {
  it("converts the register to GBP at the stored rate and never claims to be complete", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const monthStart = new Date(Date.UTC(2026, 8, 1));
      await setFxRate(db, org.id, { day: monthStart, base: "USD", rate: 0.78 });

      // $45/month of OpenAI, reverse charge, and £20/month of something UK-rated.
      await upsertCost(db, org.id, {
        supplier: "openai", name: "OpenAI", business: "shared", renewalPrice: 4500,
        currencyCode: "USD", billingPeriodUnit: "month", vatTreatment: "reverse_charge", actorId: ACTOR,
      });
      await upsertCost(db, org.id, {
        supplier: "hostinger", name: "Hosting", business: "launchflow", renewalPrice: 2000,
        currencyCode: "GBP", billingPeriodUnit: "month", vatTreatment: "standard", actorId: ACTOR,
      });

      const report = await profitReport(db, org.id, new Date(Date.UTC(2026, 8, 15)));

      // 4500 cents * 0.78 = 3510p, plus 2000p = 5510p net.
      expect(report.costNetPence).toBe(5510);
      // Only the UK-rated line adds VAT: 2000 + 400 = 2400, plus 3510 = 5910.
      expect(report.costGrossPence).toBe(5910);
      expect(report.complete).toBe(false);
      expect(report.excludes.length).toBeGreaterThan(0);
    });
  });

  it("excludes a currency with no rate and names it, rather than converting at a guess", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await upsertCost(db, org.id, {
        supplier: "hetzner", name: "Hetzner", renewalPrice: 2400, currencyCode: "EUR",
        billingPeriodUnit: "month", vatTreatment: "reverse_charge", actorId: ACTOR,
      });

      const report = await profitReport(db, org.id, new Date(Date.UTC(2026, 8, 15)));

      expect(report.missingRateCurrencies).toEqual(["EUR"]);
      // A guessed rate would have made this 2400p and looked plausible.
      expect(report.costNetPence).toBe(0);
      expect(report.lines[0]!.rateMissing).toBe(true);
    });
  });

  it("groups cost by business so Cabio's bills stay off LaunchFlow's margin", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await upsertCost(db, org.id, { supplier: "mapbox", name: "Mapbox", business: "cabio", renewalPrice: 5000, currencyCode: "GBP", actorId: ACTOR });
      await upsertCost(db, org.id, { supplier: "postmark", name: "Postmark", business: "launchflow", renewalPrice: 1000, currencyCode: "GBP", actorId: ACTOR });

      const report = await profitReport(db, org.id, new Date(Date.UTC(2026, 8, 15)));

      expect(report.costByBusiness).toEqual([
        { business: "cabio", label: "Cabio", monthlyNetPence: 5000 },
        { business: "launchflow", label: "LaunchFlow", monthlyNetPence: 1000 },
      ]);
    });
  });

  it("counts revenue ex-VAT from paid invoices, and reports the gross beside it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org.id, name: "A client", slug: `c-${crypto.randomUUID()}` })
        .returning();
      await db.insert(schema.invoices).values({
        organisationId: org.id,
        clientId: client!.id,
        number: "INV-1",
        status: "paid",
        dueAt: new Date(Date.UTC(2026, 8, 8)),
        paidAt: new Date(Date.UTC(2026, 8, 10)),
        subtotalPence: 100_000,
        vatPence: 20_000,
        totalPence: 120_000,
      });

      const report = await profitReport(db, org.id, new Date(Date.UTC(2026, 8, 15)));

      expect(report.revenueNetPence).toBe(100_000);
      expect(report.revenueGrossPence).toBe(120_000);
      expect(report.marginNetPence).toBe(100_000);
    });
  });
});
