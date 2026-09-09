import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

/**
 * Getting your data out.
 *
 * Deliberately CSV per module rather than one JSON blob of everything. A CSV
 * opens in the spreadsheet Shoji already uses, and a per-module file is the
 * shape a person actually asks for — "send me the invoices" — rather than an
 * archive somebody has to write a script to read.
 *
 * Only the columns a person would recognise are exported. Internal ids are
 * included because they are what a re-import would match on, but the noise
 * (metadata blobs, provider payloads) is not: an export nobody can read is not
 * an export.
 *
 * Import is **not** here, and that is a decision rather than an omission — see
 * the note at the bottom of this file.
 */

export const EXPORTABLE = [
  "clients", "invoices", "payments", "subscriptions", "sites", "domains", "tasks", "leads",
] as const;
export type Exportable = (typeof EXPORTABLE)[number];

export const ExportInput = z.object({
  module: z.enum(EXPORTABLE),
  /** Cap so one click cannot try to serialise a whole database into memory. */
  limit: z.number().int().min(1).max(10000).default(5000),
});
export type ExportInput = z.input<typeof ExportInput>;

export type ExportResult = { filename: string; csv: string; rows: number };

/** A value as a CSV field: quoted when it has to be, empty when it is absent. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A field containing a comma, a quote or a newline must be quoted, and inner
  // quotes doubled. Excel and Sheets both read this; neither reads it without.
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Rows to CSV.
 *
 * The header comes from the first row's keys, so a caller controls the column
 * order by controlling its select. An empty result still emits its header,
 * because a file with a header and no rows says "nothing matched" while an
 * empty file says "something went wrong".
 */
export function toCsv(rows: readonly Record<string, unknown>[], headerIfEmpty: readonly string[] = []): string {
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [...headerIfEmpty];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  // CRLF: Excel on Windows is the reader here, and it is the one that minds.
  return lines.join("\r\n");
}

/** Money is stored in pence; a spreadsheet wants pounds. */
function pounds(pence: number): string {
  return (pence / 100).toFixed(2);
}

export async function exportModule(db: Db, organisationId: string, input: ExportInput): Promise<ExportResult> {
  const v = ExportInput.parse(input);
  const stamp = new Date().toISOString().slice(0, 10);

  const rows = await (async (): Promise<Record<string, unknown>[]> => {
    switch (v.module) {
      case "clients":
        return db.select({
          id: schema.clients.id, name: schema.clients.name, slug: schema.clients.slug,
          email: schema.clients.email, status: schema.clients.status, createdAt: schema.clients.createdAt,
        }).from(schema.clients).where(eq(schema.clients.organisationId, organisationId)).limit(v.limit);

      case "invoices":
        return (await db.select({
          id: schema.invoices.id, number: schema.invoices.number, client: schema.clients.name,
          status: schema.invoices.status, issuedAt: schema.invoices.issuedAt, dueAt: schema.invoices.dueAt,
          paidAt: schema.invoices.paidAt, totalPence: schema.invoices.totalPence,
          currency: schema.invoices.currency,
        }).from(schema.invoices)
          .innerJoin(schema.clients, eq(schema.invoices.clientId, schema.clients.id))
          .where(eq(schema.invoices.organisationId, organisationId)).limit(v.limit))
          .map(({ totalPence, ...rest }) => ({ ...rest, total: pounds(totalPence) }));

      case "payments":
        return (await db.select({
          id: schema.payments.id, client: schema.clients.name, paidAt: schema.payments.paidAt,
          amountPence: schema.payments.amountPence, currency: schema.payments.currency,
          provider: schema.payments.provider, reference: schema.payments.providerRef,
          status: schema.payments.status,
        }).from(schema.payments)
          .innerJoin(schema.clients, eq(schema.payments.clientId, schema.clients.id))
          .where(eq(schema.payments.organisationId, organisationId)).limit(v.limit))
          .map(({ amountPence, ...rest }) => ({ ...rest, amount: pounds(amountPence) }));

      case "subscriptions":
        return (await db.select({
          id: schema.subscriptions.id, client: schema.clients.name, package: schema.packages.name,
          status: schema.subscriptions.status, amountPence: schema.subscriptions.amountPence,
          currency: schema.subscriptions.currency,
          periodStart: schema.subscriptions.currentPeriodStart,
          periodEnd: schema.subscriptions.currentPeriodEnd,
          stripeId: schema.subscriptions.stripeSubscriptionId,
        }).from(schema.subscriptions)
          .innerJoin(schema.clients, eq(schema.subscriptions.clientId, schema.clients.id))
          .leftJoin(schema.packages, eq(schema.subscriptions.packageId, schema.packages.id))
          .where(eq(schema.subscriptions.organisationId, organisationId)).limit(v.limit))
          .map(({ amountPence, ...rest }) => ({ ...rest, monthly: pounds(amountPence) }));

      case "sites":
        return db.select({
          id: schema.sites.id, name: schema.sites.name, client: schema.clients.name,
          primaryUrl: schema.sites.primaryUrl, status: schema.sites.status,
        }).from(schema.sites)
          .innerJoin(schema.clients, eq(schema.sites.clientId, schema.clients.id))
          .where(eq(schema.sites.organisationId, organisationId)).limit(v.limit);

      case "domains":
        return db.select({
          id: schema.domains.id, name: schema.domains.name, client: schema.clients.name,
          registrar: schema.domains.registrar, dnsProvider: schema.domains.dnsProvider,
          expiresAt: schema.domains.expiresAt, status: schema.domains.status,
        }).from(schema.domains)
          .innerJoin(schema.clients, eq(schema.domains.clientId, schema.clients.id))
          .where(eq(schema.domains.organisationId, organisationId)).limit(v.limit);

      case "tasks":
        return db.select({
          id: schema.tasks.id, title: schema.tasks.title, client: schema.clients.name,
          status: schema.tasks.status, dueAt: schema.tasks.dueAt, createdAt: schema.tasks.createdAt,
        }).from(schema.tasks)
          .leftJoin(schema.clients, eq(schema.tasks.clientId, schema.clients.id))
          .where(eq(schema.tasks.organisationId, organisationId)).limit(v.limit);

      case "leads":
        return db.select({
          id: schema.leads.id, name: schema.leads.name, email: schema.leads.email,
          status: schema.leads.status, source: schema.leads.source, createdAt: schema.leads.createdAt,
        }).from(schema.leads).where(eq(schema.leads.organisationId, organisationId)).limit(v.limit);
    }
  })();

  return { filename: `launchos-${v.module}-${stamp}.csv`, csv: toCsv(rows), rows: rows.length };
}

/**
 * On import.
 *
 * Import is not implemented, and shipping a button that half-works would be
 * worse than not having one. Reading a CSV is the easy tenth; the rest is
 * deciding what happens when a row already exists, when a client name matches
 * two clients, when an invoice number collides with a live sequence, and what
 * a half-applied import leaves behind when row four hundred fails validation.
 *
 * Those are business decisions, not code ones, and the answers differ per
 * module: importing leads is nearly free, importing invoices touches a number
 * sequence and a ledger. When it is built it wants its own spec, a dry-run
 * that reports what *would* change before anything does, and a single
 * transaction per file so a failure leaves nothing behind.
 */
