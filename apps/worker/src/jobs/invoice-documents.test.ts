import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { renderPdf, type RenderPdfInput } from "@launchos/channels/pdf";
import { afterAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { runInvoiceDocuments } from "./invoice-documents.js";

const storage = await mkdtemp(join(tmpdir(), "launchos-invoice-doc-"));
const ENV = { STORAGE_DIR: storage, APP_URL: "https://os.launchflow.test", PDF_RENDERER: "mock", NODE_ENV: "test" } as NodeJS.ProcessEnv;
const quiet = () => ({ error: vi.fn(), info: vi.fn() });

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `inv-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "KD Landscapes", slug: `kd-${randomUUID()}`, email: "kelly@kdlandscapes.test",
  }).returning();
  return { organisationId: org!.id, clientId: client!.id };
}

type InvoiceStatus = (typeof schema.invoiceStatusEnum.enumValues)[number];

async function invoice(db: Db, organisationId: string, clientId: string, number: string, status: InvoiceStatus, issuedAt: Date) {
  const [row] = await db.insert(schema.invoices).values({
    organisationId, clientId, number, status, issuedAt,
    dueAt: new Date(issuedAt.getTime() + 14 * 86_400_000),
    subtotalPence: 14900, vatPence: 2980, totalPence: 17880, currency: "GBP",
    lineItems: [{ description: "Care plan", quantity: 1, unitPence: 14900 }],
  }).returning();
  return row!;
}

describe("runInvoiceDocuments", () => {
  it("draws the PDF for every invoice that has none, newest first, and files it against the row", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const older = await invoice(db, f.organisationId, f.clientId, `LF-A-${randomUUID().slice(0, 8)}`, "sent", new Date("2026-07-01T09:00:00Z"));
      const newest = await invoice(db, f.organisationId, f.clientId, `LF-B-${randomUUID().slice(0, 8)}`, "draft", new Date("2026-09-01T09:00:00Z"));

      const result = await runInvoiceDocuments(db, f.organisationId, { env: ENV, logger: quiet() });

      expect(result).toEqual({ pending: 2, rendered: 2, failed: 0 });
      const rows = await db.select().from(schema.invoices).where(eq(schema.invoices.organisationId, f.organisationId));
      expect(rows.every((row) => row.documentId !== null)).toBe(true);
      const documents = await db.select().from(schema.documents).where(and(
        eq(schema.documents.organisationId, f.organisationId), eq(schema.documents.kind, "invoice"),
      ));
      expect(documents).toHaveLength(2);
      expect(documents.map((d) => d.reference).sort()).toEqual([older.number, newest.number].sort());
    });
  });

  it("leaves a void invoice unrendered — cancelled paper nobody should be handed", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await invoice(db, f.organisationId, f.clientId, `LF-V-${randomUUID().slice(0, 8)}`, "void", new Date("2026-08-01T09:00:00Z"));

      expect(await runInvoiceDocuments(db, f.organisationId, { env: ENV, logger: quiet() })).toEqual({ pending: 0, rendered: 0, failed: 0 });
    });
  });

  it("renders each invoice once, however often the tick comes round", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await invoice(db, f.organisationId, f.clientId, `LF-C-${randomUUID().slice(0, 8)}`, "sent", new Date("2026-09-01T09:00:00Z"));

      const first = await runInvoiceDocuments(db, f.organisationId, { env: ENV, logger: quiet() });
      const second = await runInvoiceDocuments(db, f.organisationId, { env: ENV, logger: quiet() });

      expect(first.rendered).toBe(1);
      // An invoice is a financial record: its PDF must not change between two
      // people looking at it, so the second tick finds nothing to do.
      expect(second).toEqual({ pending: 0, rendered: 0, failed: 0 });
      const documents = await db.select().from(schema.documents).where(and(
        eq(schema.documents.organisationId, f.organisationId), eq(schema.documents.kind, "invoice"),
      ));
      expect(documents).toHaveLength(1);
    });
  });

  it("takes at most a batch a tick and never another organisation's invoices", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      for (const n of [1, 2, 3]) {
        await invoice(db, mine.organisationId, mine.clientId, `LF-M${n}-${randomUUID().slice(0, 8)}`, "sent", new Date(`2026-0${n}-01T09:00:00Z`));
      }
      await invoice(db, theirs.organisationId, theirs.clientId, `LF-T-${randomUUID().slice(0, 8)}`, "sent", new Date("2026-09-01T09:00:00Z"));

      const result = await runInvoiceDocuments(db, mine.organisationId, { env: ENV, limit: 2, logger: quiet() });

      expect(result).toEqual({ pending: 2, rendered: 2, failed: 0 });
      const untouched = await db.select().from(schema.invoices).where(eq(schema.invoices.organisationId, theirs.organisationId));
      expect(untouched[0]!.documentId).toBeNull();
    });
  });

  it("draws the rest of the batch when one invoice fails, then fails the job", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const bad = await invoice(db, f.organisationId, f.clientId, `LF-X-${randomUUID().slice(0, 8)}`, "sent", new Date("2026-09-02T09:00:00Z"));
      await invoice(db, f.organisationId, f.clientId, `LF-Y-${randomUUID().slice(0, 8)}`, "sent", new Date("2026-09-01T09:00:00Z"));
      let seen = 0;
      // Everything real except the first render, which dies the way a browser
      // that will not start does. The newest invoice is drawn first, so the
      // first call is the bad one.
      const render = vi.fn(async (input: RenderPdfInput) => {
        seen += 1;
        if (seen === 1) throw new Error("chromium would not start");
        return renderPdf(input);
      });

      await expect(runInvoiceDocuments(db, f.organisationId, { env: ENV, render, logger: quiet() })).rejects.toThrow(AggregateError);

      const [failed] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, bad.id));
      expect(failed!.documentId).toBeNull();
      const documents = await db.select().from(schema.documents).where(eq(schema.documents.organisationId, f.organisationId));
      expect(documents).toHaveLength(1);
    });
  });
});
