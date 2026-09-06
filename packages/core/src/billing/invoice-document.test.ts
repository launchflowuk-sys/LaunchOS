import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { tinyPdf } from "@launchos/channels/pdf";
import { setEnqueue } from "../events/emit.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { ensureInvoiceDocument, invoiceDocumentHtml, invoiceDocumentInput } from "./invoice-document.js";
import { vatRatePercentCharged } from "./vat-rate.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-invoice-doc-"));
const ENV = { STORAGE_DIR: storage, APP_URL: "https://os.launchflow.test" };
const DEPS = { render: async () => tinyPdf("Invoice") };

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

async function invoiceFixture(db: Db, vat: { supplierNumber?: string; vatPence: number }) {
  const seeded = await seedOrgWithClient(db);
  if (vat.supplierNumber) {
    await db.update(schema.organisations).set({ vatNumber: vat.supplierNumber })
      .where(eq(schema.organisations.id, seeded.organisationId));
  }
  await db.insert(schema.billingProfiles).values({
    organisationId: seeded.organisationId,
    clientId: seeded.clientId,
    billingName: "Grays CabLine Ltd",
    addressLine1: "1 High Street",
    city: "Grays",
    postcode: "RM17 6QB",
  });
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: seeded.organisationId,
    clientId: seeded.clientId,
    number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: "sent",
    issuedAt: new Date("2026-09-01T09:00:00Z"),
    dueAt: new Date("2026-09-15T09:00:00Z"),
    subtotalPence: 25_000,
    vatPence: vat.vatPence,
    totalPence: 25_000 + vat.vatPence,
    lineItems: [{ description: "Care plan — 2026-09", quantity: 1, unitPence: 25_000 }],
  }).returning();
  return { ...seeded, invoice: invoice! };
}

describe("vatRatePercentCharged", () => {
  it("reads the rate off the invoice's own figures, and refuses to invent one", () => {
    expect(vatRatePercentCharged(25_000, 5_000)).toBe(20);
    expect(vatRatePercentCharged(10_000, 500)).toBe(5);
    // Nothing to divide by is no rate, not 0% of something.
    expect(vatRatePercentCharged(0, 0)).toBe(0);
    expect(vatRatePercentCharged(25_000, 0)).toBe(0);
  });
});

describe("invoiceDocumentHtml", () => {
  it("renders VAT as the invoice carries it, with the registration number", async () => {
    await withTestDb(async (db) => {
      const { organisationId, invoice } = await invoiceFixture(db, { supplierNumber: "GB123456789", vatPence: 5_000 });

      const html = invoiceDocumentHtml(await invoiceDocumentInput(db, organisationId, invoice));

      expect(html).toContain("Grays CabLine Ltd");
      expect(html).toContain("1 High Street");
      expect(html).toContain("Care plan — 2026-09");
      expect(html).toContain("VAT at 20%");
      expect(html).toContain("GB123456789");
      expect(html).toContain("£300.00");
      expect(html).toContain("Total due");
    });
  });

  it("says plainly that no VAT was charged when the supplier is not registered", async () => {
    await withTestDb(async (db) => {
      const { organisationId, invoice } = await invoiceFixture(db, { vatPence: 0 });

      const html = invoiceDocumentHtml(await invoiceDocumentInput(db, organisationId, invoice));

      // The registration is the whole test — `vat-rate.ts` says so, and the
      // document must not imply a rate an unregistered supplier cannot charge.
      expect(html).not.toContain("VAT at");
      expect(html).toContain("not registered for VAT");
      expect(html).toContain("£250.00");
    });
  });
});

describe("ensureInvoiceDocument", () => {
  it("renders once, files it on the invoice, and hands the same file back after that", async () => {
    await withTestDb(async (db) => {
      const { organisationId, invoice } = await invoiceFixture(db, { supplierNumber: "GB123456789", vatPence: 5_000 });

      const first = await ensureInvoiceDocument(db, organisationId, { invoiceId: invoice.id }, DEPS, ENV);
      const second = await ensureInvoiceDocument(db, organisationId, { invoiceId: invoice.id }, DEPS, ENV);

      expect(first.kind).toBe("invoice");
      expect(first.reference).toBe(invoice.number);
      expect(first.subjectId).toBe(invoice.id);
      // An invoice is a financial record: its PDF must not change between two
      // people looking at it.
      expect(second.id).toBe(first.id);
      const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(row!.documentId).toBe(first.id);
    });
  });

  it("will not render another organisation's invoice", async () => {
    await withTestDb(async (db) => {
      const { invoice } = await invoiceFixture(db, { vatPence: 0 });
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `o-${randomUUID()}` }).returning();

      await expect(ensureInvoiceDocument(db, other!.id, { invoiceId: invoice.id }, DEPS, ENV)).rejects.toThrow();
    });
  });
});
