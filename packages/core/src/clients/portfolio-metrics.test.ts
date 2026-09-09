import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "./create-client.js";
import { clientPortfolioMetrics } from "./portfolio-metrics.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

let invoiceNo = 0;
async function invoice(db: Db, organisationId: string, clientId: string, totalPence: number, status: "paid" | "sent") {
  const [row] = await db.insert(schema.invoices).values({
    organisationId, clientId,
    number: `INV-${++invoiceNo}-${crypto.randomUUID().slice(0, 8)}`,
    status,
    dueAt: new Date(),
    subtotalPence: totalPence, totalPence,
    ...(status === "paid" ? { paidAt: new Date() } : {}),
  }).returning();
  return row!;
}

async function payment(db: Db, organisationId: string, clientId: string, amountPence: number, opts: { invoiceId?: string; status?: "succeeded" | "pending" | "failed"; provider?: "stripe" | "bank" | "cash" | "other" } = {}) {
  const [row] = await db.insert(schema.payments).values({
    organisationId, clientId, amountPence,
    provider: opts.provider ?? "bank",
    providerRef: crypto.randomUUID(),
    status: opts.status ?? "succeeded",
    paidAt: new Date(),
    ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}),
  }).returning();
  return row!;
}

describe("clientPortfolioMetrics", () => {
  /**
   * The bug this file was written for. Shoji invoices most clients by bank
   * transfer and records the money as a payment; nothing marks the invoice
   * `paid`. "Collected to date" summed paid invoices only, so a real book of
   * business read £0.00 while the Payments screen showed the money.
   */
  it("counts money recorded as a payment, not only invoices somebody marked paid", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "AMO Rendering" });
      const sent = await invoice(db, org.id, client.id, 20_000, "sent");
      await payment(db, org.id, client.id, 20_000, { invoiceId: sent.id });

      expect((await clientPortfolioMetrics(db, org.id)).lifetimePence).toBe(20_000);
    });
  });

  it("does not count the same money twice when the invoice is marked paid as well", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Gateway Taxis" });
      const settled = await invoice(db, org.id, client.id, 5_999, "paid");
      await payment(db, org.id, client.id, 5_999, { invoiceId: settled.id, provider: "stripe" });

      expect((await clientPortfolioMetrics(db, org.id)).lifetimePence).toBe(5_999);
    });
  });

  it("still counts a paid invoice that has no payment row against it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Historic" });
      await invoice(db, org.id, client.id, 12_500, "paid");

      expect((await clientPortfolioMetrics(db, org.id)).lifetimePence).toBe(12_500);
    });
  });

  it("counts a payment with no invoice at all — cash in hand is still collected", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Walk-in" });
      await payment(db, org.id, client.id, 4_000, { provider: "cash" });

      expect((await clientPortfolioMetrics(db, org.id)).lifetimePence).toBe(4_000);
    });
  });

  it("ignores money that has not arrived: pending and failed payments, unpaid invoices", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Hopeful" });
      await invoice(db, org.id, client.id, 90_000, "sent");
      await payment(db, org.id, client.id, 1_000, { status: "pending" });
      await payment(db, org.id, client.id, 2_000, { status: "failed" });

      expect((await clientPortfolioMetrics(db, org.id)).lifetimePence).toBe(0);
    });
  });

  it("never counts another organisation's money", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const theirClient = await createClient(db, theirs.id, { name: "Someone else" });
      await payment(db, theirs.id, theirClient.id, 100_000);

      expect((await clientPortfolioMetrics(db, mine.id)).lifetimePence).toBe(0);
    });
  });
});
