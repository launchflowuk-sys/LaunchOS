import { escapeHtml } from "@launchos/channels";
import { DOCUMENT_MARGIN, renderDocumentHtml, renderPdf, type RenderPdfInput } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { InvoiceLineItem } from "@launchos/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { getDocument, storeDocument, type DocumentKind, type DocumentRow } from "../documents/store-document.js";
import { formatPence } from "../proposals/pricing.js";
import { ukLongDate } from "../tasks/dates.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { isVatRegistered, vatRatePercentCharged } from "./vat-rate.js";

/**
 * The invoice on LaunchFlow's headed paper — the same paper as the proposal
 * the client agreed to and the handover they signed off.
 *
 * **The VAT rule is not decided here.** `vat-rate.ts` is the single authority
 * on whether this organisation may charge VAT at all, and
 * `createInvoiceFromSubscription` has already applied it: the row carries the
 * subtotal, the VAT and the total it was raised with. This file prints those
 * figures and reads the rate back off them with `vatRatePercentCharged`, so a
 * re-render years later still shows the rate that invoice actually carried.
 * The supplier's VAT number is printed when there is one, because a VAT
 * invoice legally has to show it, and the zero-rated note is printed when
 * there is not — which is the same registration test `vat-rate.ts` makes.
 */

export const INVOICE_DOCUMENT_KIND: DocumentKind = "invoice";
/** `documents.subject_type` for an invoice PDF. */
export const INVOICE_SUBJECT_TYPE = "invoice";

type InvoiceRow = typeof schema.invoices.$inferSelect;

export interface InvoiceDocumentInput {
  invoice: InvoiceRow;
  /** Who it is billed to: the billing name where there is one, else the client's. */
  billTo: string;
  /** The address block, one line per entry. Already ordered. */
  billToAddress: readonly string[];
  /** The supplier's own VAT registration number, when they hold one. */
  supplierVatNumber: string | null;
  /** The client's VAT number, printed when they gave us one. */
  clientVatNumber: string | null;
}

/** The document's title, at the top of page one and in the PDF's own metadata. */
export function invoiceDocumentTitle(invoice: Pick<InvoiceRow, "number">): string {
  return `Invoice ${invoice.number}`;
}

function linesHtml(lines: readonly InvoiceLineItem[]): string {
  const rows = lines
    .map((line) => {
      const quantity = line.quantity === 1 ? "" : `${line.quantity} × ${formatPence(line.unitPence)}`;
      const total = formatPence(line.quantity * line.unitPence);
      return `<tr><td>${escapeHtml(line.description)}</td><td class="numeric">${escapeHtml(quantity)}</td><td class="numeric">${escapeHtml(total)}</td></tr>`;
    })
    .join("");
  return rows || `<tr><td>Services</td><td class="numeric"></td><td class="numeric"></td></tr>`;
}

/**
 * The money, in the order an accountant reads it: subtotal, VAT with its rate
 * stated, then the total. The VAT row is printed even at zero when the
 * supplier is registered — "VAT at 0%" is a statement; a missing row is a
 * question.
 */
function totalsHtml(invoice: InvoiceRow, vatRegistered: boolean): string {
  const rate = vatRatePercentCharged(invoice.subtotalPence, invoice.vatPence);
  const vatRow = vatRegistered
    ? `<tr><td>VAT at ${escapeHtml(String(rate))}%</td><td class="numeric"></td><td class="numeric">${escapeHtml(formatPence(invoice.vatPence))}</td></tr>`
    : "";
  return `<tr><td>Subtotal</td><td class="numeric"></td><td class="numeric">${escapeHtml(formatPence(invoice.subtotalPence))}</td></tr>
    ${vatRow}
    <tr class="total"><td>Total due</td><td class="numeric"></td><td class="numeric">${escapeHtml(formatPence(invoice.totalPence))}</td></tr>`;
}

/** The HTML for an invoice, ready for `renderPdf`. */
export function invoiceDocumentHtml(input: InvoiceDocumentInput): string {
  const { invoice } = input;
  const vatRegistered = isVatRegistered(input.supplierVatNumber);
  const meta = [
    { label: "Invoice", value: invoice.number },
    { label: "Issued", value: ukLongDate(invoice.issuedAt) },
    { label: "Due", value: ukLongDate(invoice.dueAt) },
    ...(vatRegistered ? [{ label: "VAT number", value: input.supplierVatNumber! }] : []),
  ];

  const address = input.billToAddress.length > 0
    ? `<p class="muted">${input.billToAddress.map((line) => escapeHtml(line)).join("<br />")}</p>`
    : "";
  const clientVat = input.clientVatNumber
    ? `<p class="muted">VAT number ${escapeHtml(input.clientVatNumber)}</p>`
    : "";

  const bodyHtml = `<h2>Billed to</h2>
    <p><strong>${escapeHtml(input.billTo)}</strong></p>
    ${address}
    ${clientVat}
    <h2>What this covers</h2>
    <table><tbody>${linesHtml(invoice.lineItems)}${totalsHtml(invoice, vatRegistered)}</tbody></table>
    ${invoice.status === "paid" && invoice.paidAt
      ? `<p><strong>Paid in full on ${escapeHtml(ukLongDate(invoice.paidAt))}. Thank you.</strong></p>`
      : `<p>Payment is due by <strong>${escapeHtml(ukLongDate(invoice.dueAt))}</strong>. You can pay and see every invoice in your portal.</p>`}`;

  return renderDocumentHtml({
    title: invoiceDocumentTitle(invoice),
    subtitle: `For ${input.billTo}`,
    meta,
    bodyHtml,
    // The registration is the whole VAT test — see `vat-rate.ts`. An
    // unregistered supplier charging VAT is money the client's accountant
    // rejects, so the document says plainly that none was charged.
    closingNote: vatRegistered
      ? `All amounts are in ${invoice.currency}. VAT is charged at ${vatRatePercentCharged(invoice.subtotalPence, invoice.vatPence)}% under registration ${input.supplierVatNumber}.`
      : `All amounts are in ${invoice.currency}. LaunchFlow is not registered for VAT, so no VAT has been charged on this invoice.`,
  });
}

/** The render request: the HTML, A4, and the invoice number in the footer. */
export function invoiceRenderInput(input: InvoiceDocumentInput): RenderPdfInput {
  return {
    html: invoiceDocumentHtml(input),
    format: "A4",
    margin: DOCUMENT_MARGIN,
    footerReference: input.invoice.number,
  };
}

/** What rendering an invoice needs from the outside world. */
export interface InvoiceDocumentDeps {
  render?: ((input: RenderPdfInput) => Promise<Uint8Array<ArrayBuffer>>) | undefined;
}

/** Everything the template needs, gathered org-scoped. */
export async function invoiceDocumentInput(db: Db, organisationId: string, invoice: InvoiceRow): Promise<InvoiceDocumentInput> {
  const [client] = await db.select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, invoice.clientId), eq(schema.clients.organisationId, organisationId)));
  const [profile] = await db.select().from(schema.billingProfiles)
    .where(and(
      eq(schema.billingProfiles.organisationId, organisationId),
      eq(schema.billingProfiles.clientId, invoice.clientId),
    ));
  const [organisation] = await db.select({ vatNumber: schema.organisations.vatNumber })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));

  const address = [profile?.addressLine1, profile?.addressLine2, profile?.city, profile?.postcode, profile?.country]
    .filter((line): line is string => Boolean(line?.trim()));

  return {
    invoice,
    billTo: profile?.billingName?.trim() || client?.name || "Customer",
    billToAddress: address,
    supplierVatNumber: organisation?.vatNumber ?? null,
    clientVatNumber: profile?.vatNumber ?? null,
  };
}

export const EnsureInvoiceDocumentInput = z.object({
  invoiceId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type EnsureInvoiceDocumentInput = z.input<typeof EnsureInvoiceDocumentInput>;

/**
 * The invoice as a stored PDF, rendered once and kept.
 *
 * `invoices.document_id` is the stamp: an invoice that already has one is
 * handed back its document rather than re-rendered, so a resend, an overdue
 * chase and a portal download all give the client the same file — and the
 * file's `sha256` still means something. An invoice is a financial record; the
 * PDF of it should not quietly change between two people looking at it.
 *
 * The render happens outside a transaction for the same reason it does
 * everywhere else: a browser call must not hold a database lock.
 */
export async function ensureInvoiceDocument(
  db: Db,
  organisationId: string,
  input: EnsureInvoiceDocumentInput,
  deps?: InvoiceDocumentDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentRow> {
  const v = EnsureInvoiceDocumentInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [invoice] = await db.select().from(schema.invoices)
    .where(and(eq(schema.invoices.id, v.invoiceId), eq(schema.invoices.organisationId, organisationId)));
  if (!invoice) throw new Error(`invoice ${v.invoiceId} not found in organisation`);

  if (invoice.documentId) {
    const existing = await getDocument(db, organisationId, { documentId: invoice.documentId });
    if (existing) return existing;
  }

  const render = deps?.render ?? ((request: RenderPdfInput) => renderPdf(request));
  const bytes = await render(invoiceRenderInput(await invoiceDocumentInput(db, organisationId, invoice)));
  const document = await storeDocument(db, organisationId, {
    kind: INVOICE_DOCUMENT_KIND,
    title: invoiceDocumentTitle(invoice),
    reference: invoice.number,
    clientId: invoice.clientId,
    subjectType: INVOICE_SUBJECT_TYPE,
    subjectId: invoice.id,
    bytes,
    actorKind: v.actorKind,
    ...(v.actorId ? { actorId: v.actorId } : {}),
  }, env);

  // `document_id IS NULL` in the update, not a read-then-write: two sends
  // racing must leave one document on the invoice, and the loser's file is an
  // orphan rather than a second "the" PDF.
  const [after] = await db.update(schema.invoices)
    .set({ documentId: document.id, updatedAt: new Date() })
    .where(and(
      eq(schema.invoices.id, invoice.id),
      eq(schema.invoices.organisationId, organisationId),
      isNull(schema.invoices.documentId),
    ))
    .returning();
  if (!after) {
    // Lost the claim: their document is the one the invoice carries, so it is
    // the one every reader must be given.
    const [current] = await db.select({ documentId: schema.invoices.documentId }).from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.organisationId, organisationId)));
    const winner = current?.documentId
      ? await getDocument(db, organisationId, { documentId: current.documentId })
      : null;
    return winner ?? document;
  }
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "invoice.document_rendered",
    targetType: "invoice", targetId: invoice.id, before: invoice, after,
  });
  return document;
}
