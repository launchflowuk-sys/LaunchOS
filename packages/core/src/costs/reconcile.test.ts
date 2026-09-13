import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { describe, expect, it } from "vitest";
import { setFxRate } from "./fx.js";
import { reconcileSupplier } from "./reconcile.js";
import { syncStripeFees } from "./stripe-fees.js";
import { recordUsage, setUsageRate, usageTotals } from "./usage.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return org!;
}

const SEPTEMBER = new Date(Date.UTC(2026, 8, 15));

describe("reconcileSupplier", () => {
  it("matches when the bill is within tolerance", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", microPencePerUnit: 790, effectiveFrom: new Date(Date.UTC(2026, 0, 1)) });
      await recordUsage(db, org.id, {
        supplier: "openai", product: "tokens_out", quantity: 1_000_000,
        occurredAt: SEPTEMBER, idempotencyKey: "a",
      });

      // Metered 790p. A bill of 800p is inside 10%.
      const result = await reconcileSupplier(db, org.id, { supplier: "openai", billedMinor: 800 }, SEPTEMBER);

      expect(result.meteredPence).toBe(790);
      expect(result.billedPence).toBe(800);
      expect(result.status).toBe("matched");
    });
  });

  it("flags a gap outside tolerance and says which way it went", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", microPencePerUnit: 790, effectiveFrom: new Date(Date.UTC(2026, 0, 1)) });
      await recordUsage(db, org.id, {
        supplier: "openai", product: "tokens_out", quantity: 1_000_000,
        occurredAt: SEPTEMBER, idempotencyKey: "a",
      });

      const result = await reconcileSupplier(db, org.id, { supplier: "openai", billedMinor: 2_000 }, SEPTEMBER);

      expect(result.status).toBe("gap");
      expect(result.gapPence).toBe(1_210);
      expect(result.note).toMatch(/higher/);
    });
  });

  it("reports not_reconciled for a missing credential rather than a zero gap", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const result = await reconcileSupplier(db, org.id, { supplier: "anthropic", billedMinor: null }, SEPTEMBER);

      // The rule: a provider nobody could check must look unchecked. A zero
      // gap here would read as a clean bill of health.
      expect(result.status).toBe("not_reconciled");
      expect(result.gapPence).toBeNull();
      expect(result.billedPence).toBeNull();
    });
  });

  it("converts a dollar bill at the month's stored rate", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setFxRate(db, org.id, { day: new Date(Date.UTC(2026, 8, 1)), base: "USD", rate: 0.79 });
      await setUsageRate(db, org.id, { supplier: "openai", product: "tokens_out", microPencePerUnit: 790, effectiveFrom: new Date(Date.UTC(2026, 0, 1)) });
      await recordUsage(db, org.id, {
        supplier: "openai", product: "tokens_out", quantity: 1_000_000,
        occurredAt: SEPTEMBER, idempotencyKey: "a",
      });

      // $10.00 billed => 1000 cents * 0.79 = 790p, exactly what was metered.
      const result = await reconcileSupplier(db, org.id, { supplier: "openai", billedMinor: 1_000, billedCurrency: "USD" }, SEPTEMBER);

      expect(result.billedPence).toBe(790);
      expect(result.status).toBe("matched");
    });
  });

  it("refuses to compare a foreign bill with no exchange rate", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const result = await reconcileSupplier(db, org.id, { supplier: "openai", billedMinor: 1_000, billedCurrency: "USD" }, SEPTEMBER);

      expect(result.status).toBe("not_reconciled");
      expect(result.note).toMatch(/exchange rate/i);
    });
  });
});

describe("syncStripeFees", () => {
  it("records each fee once, however often it runs", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const payments = new MockPaymentsAdapter();
      const now = new Date(Date.UTC(2026, 8, 12));

      const first = await syncStripeFees(db, org.id, payments, now);
      const second = await syncStripeFees(db, org.id, payments, now);

      expect(first.recorded).toBe(2);
      expect(first.feeByCurrency.GBP).toBe(198);
      // The window is a lookback, so an overlapping re-run is the normal case.
      expect(second.recorded).toBe(0);
      expect(second.feeByCurrency.GBP).toBe(198);
    });
  });

  it("prices the fee at face value rather than asking the rate card to guess", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await setUsageRate(db, org.id, {
        supplier: "stripe", product: "fee", variant: "GBP",
        microPencePerUnit: 1_000_000, effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      });

      await syncStripeFees(db, org.id, new MockPaymentsAdapter(), new Date(Date.UTC(2026, 8, 12)));

      // 198 minor units at one penny each = 198p, which is the fee itself.
      const totals = await usageTotals(db, org.id, new Date(Date.UTC(2026, 8, 12)));
      expect(totals.bySupplier.find((s) => s.supplier === "stripe")?.pence).toBe(198);
    });
  });
});
