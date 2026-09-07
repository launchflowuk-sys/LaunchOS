import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { listInvoices } from "./list-invoices.js";

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** `number`, `dueAt` and `subtotalPence` are NOT NULL, so every insert supplies them unless the case is about them. */
async function addInvoice(db: Db, organisationId: string, clientId: string, values: Record<string, unknown>): Promise<void> {
  await db.insert(schema.invoices).values({
    organisationId,
    clientId,
    currency: "GBP",
    number: `INV-${randomUUID().slice(0, 8)}`,
    dueAt: new Date(),
    subtotalPence: 0,
    ...values,
  } as never);
}

describe("listInvoices", () => {
  it("totals every matching invoice, not just the page that came back", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      for (let i = 0; i < 5; i += 1) {
        await addInvoice(db, organisationId, clientId, { totalPence: 1000, status: "sent", issuedAt: new Date() });
      }

      const page = await listInvoices(db, organisationId, { limit: 2 });
      expect(page.invoices).toHaveLength(2);
      expect(page.total).toBe(5);
      // The number that matters: paging must not change the answer to
      // "how much am I owed". Without this an assistant adds up one page.
      expect(page.totalPenceMatching).toBe(5000);
    });
  });

  it("comes back as a number with no invoices at all", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const empty = await listInvoices(db, organisationId);
      // Postgres sum() is null over no rows and a numeric *string* over some;
      // either reaching a caller unconverted turns addition into concatenation.
      expect(empty.totalPenceMatching).toBe(0);
      expect(typeof empty.totalPenceMatching).toBe("number");
    });
  });

  it("adds up as a number rather than concatenating", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await addInvoice(db, organisationId, clientId, { totalPence: 100, status: "sent", issuedAt: new Date() });
      await addInvoice(db, organisationId, clientId, { totalPence: 23, status: "sent", issuedAt: new Date() });

      const result = await listInvoices(db, organisationId);
      expect(result.totalPenceMatching).toBe(123);
      expect(typeof result.totalPenceMatching).toBe("number");
    });
  });

  it("carries the client name and says how many days a bill is past due", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await addInvoice(db, organisationId, clientId, {
        totalPence: 4500, status: "overdue", issuedAt: new Date(),
        dueAt: new Date(Date.now() - 3 * 86_400_000),
      });

      const { invoices } = await listInvoices(db, organisationId);
      expect(invoices[0]!.clientName).toBe("Grays CabLine");
      expect(invoices[0]!.overdueDays).toBe(3);
    });
  });

  it("leaves overdueDays null for anything not actually overdue, however old the due date", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await addInvoice(db, organisationId, clientId, {
        totalPence: 4500, status: "paid", issuedAt: new Date(), dueAt: new Date(Date.now() - 3 * 86_400_000),
      });
      expect((await listInvoices(db, organisationId)).invoices[0]!.overdueDays).toBeNull();
    });
  });

  it("filters by status and by client", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await addInvoice(db, organisationId, clientId, { totalPence: 100, status: "paid", issuedAt: new Date() });
      await addInvoice(db, organisationId, clientId, { totalPence: 200, status: "overdue", issuedAt: new Date() });

      expect((await listInvoices(db, organisationId, { status: "overdue" })).totalPenceMatching).toBe(200);
      expect((await listInvoices(db, organisationId, { clientId })).total).toBe(2);
    });
  });

  it("includes a voided invoice rather than dropping it silently", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await addInvoice(db, organisationId, clientId, { totalPence: 900, status: "void", issuedAt: new Date() });
      // A voided invoice is a fact about the month. A list that quietly omits
      // rows is a list nobody can reconcile against the ledger.
      expect((await listInvoices(db, organisationId)).total).toBe(1);
      expect((await listInvoices(db, organisationId, { status: "void" })).total).toBe(1);
    });
  });

  it("shows one organisation only its own", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await addInvoice(db, a.organisationId, a.clientId, { totalPence: 999, status: "sent", issuedAt: new Date() });

      expect((await listInvoices(db, a.organisationId)).totalPenceMatching).toBe(999);
      expect((await listInvoices(db, b.organisationId)).totalPenceMatching).toBe(0);
    });
  });
});
