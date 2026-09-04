import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "../test/db.js";
import {
  adAccounts, adMetricSnapshots, adReports, clientReports, clients, invoices,
  organisations, payments, subscriptions,
} from "./index.js";

describe("P5 schema", () => {
  it("stores a subscription, invoice, payment, ad snapshot and client report for one client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `p5-${randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-cabline-${randomUUID()}` }).returning();

      const [sub] = await db.insert(subscriptions).values({
        organisationId: org!.id, clientId: client!.id, amountPence: 29900,
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
      }).returning();
      expect(sub!.status).toBe("active");
      expect(sub!.currency).toBe("GBP");

      const [invoice] = await db.insert(invoices).values({
        organisationId: org!.id, clientId: client!.id, subscriptionId: sub!.id, number: "LF-2026-0001",
        issuedAt: new Date("2026-09-01T00:00:00Z"), dueAt: new Date("2026-09-15T00:00:00Z"),
        subtotalPence: 29900, vatPence: 5980, totalPence: 35880,
        lineItems: [{ description: "Growth package — September 2026", quantity: 1, unitPence: 29900 }],
      }).returning();
      expect(invoice!.status).toBe("draft");

      const [payment] = await db.insert(payments).values({
        organisationId: org!.id, clientId: client!.id, invoiceId: invoice!.id,
        amountPence: 35880, provider: "bank", status: "succeeded", paidAt: new Date(),
      }).returning();
      expect(payment!.currency).toBe("GBP");

      const [account] = await db.insert(adAccounts).values({
        organisationId: org!.id, clientId: client!.id, platform: "google",
        externalId: "123-456-7890", name: "Grays CabLine — Search",
      }).returning();
      await db.insert(adMetricSnapshots).values({
        organisationId: org!.id, adAccountId: account!.id, date: "2026-09-01",
        spendPence: 12000, impressions: 5400, clicks: 210, conversions: 14,
        conversionValuePence: 84000, cpcPence: 57.1, roas: 7,
      });
      const snaps = await db.select().from(adMetricSnapshots).where(eq(adMetricSnapshots.adAccountId, account!.id));
      expect(snaps).toHaveLength(1);

      const [report] = await db.insert(adReports).values({
        organisationId: org!.id, adAccountId: account!.id,
        periodStart: "2026-08-25", periodEnd: "2026-08-31", summaryMd: "## Ads\nROAS fell 24%.",
      }).returning();
      expect(report!.status).toBe("draft");

      const [clientReport] = await db.insert(clientReports).values({
        organisationId: org!.id, clientId: client!.id,
        periodStart: "2026-08-01", periodEnd: "2026-08-31",
        summaryMd: "## August\nAll good.", stats: { tasksDone: 4 },
      }).returning();
      expect(clientReport!.status).toBe("draft");
    });
  });

  it("rejects a second snapshot for the same account and date", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "T", slug: `p5-${randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const [account] = await db.insert(adAccounts).values({
        organisationId: org!.id, clientId: client!.id, platform: "meta", externalId: "act_1", name: "A",
      }).returning();
      const row = {
        organisationId: org!.id, adAccountId: account!.id, date: "2026-09-01",
        spendPence: 1, impressions: 1, clicks: 1, conversions: 0, conversionValuePence: 0, cpcPence: 1, roas: 0,
      };
      await db.insert(adMetricSnapshots).values(row);
      // Wrapped in a nested transaction (drizzle issues a SAVEPOINT) so the
      // expected constraint violation doesn't abort the outer test transaction.
      await expect(
        db.transaction((tx) => tx.insert(adMetricSnapshots).values(row)),
      ).rejects.toThrow();
    });
  });
});
