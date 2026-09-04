import type { InvoiceLineItem } from "@launchos/db/schema";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatPence } from "@/lib/format";

/**
 * The supplier — us. HMRC requires a VAT invoice to carry the supplier's name,
 * address and VAT registration number, so every one of these is printed rather
 * than assumed. They live on `organisations` and are edited on
 * Settings → Organisation.
 */
export interface InvoiceSupplier {
  name: string;
  legalName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  vatNumber: string | null;
  companyNumber: string | null;
  invoiceFooter: string | null;
}

export interface InvoiceDocumentData {
  number: string;
  status: string;
  issuedAt: Date;
  dueAt: Date;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  lineItems: InvoiceLineItem[];
}

/**
 * The rate actually charged, recovered from the amounts.
 *
 * `invoices` stores money, not the rate that produced it, so the rate is
 * derived rather than looked up — which also means a historic invoice keeps
 * printing the rate it was raised at after the standard rate changes. Rounded
 * to one decimal so 20% prints as "20%" and the reduced 12.5% rate survives.
 */
export function vatRatePercent(subtotalPence: number, vatPence: number): number | null {
  if (subtotalPence <= 0 || vatPence <= 0) return null;
  return Math.round((vatPence / subtotalPence) * 1000) / 10;
}

function supplierLines(supplier: InvoiceSupplier): string[] {
  return [
    supplier.addressLine1,
    supplier.addressLine2,
    supplier.city,
    supplier.postcode,
    supplier.country,
  ].filter((line): line is string => Boolean(line));
}

/**
 * The printable invoice, shared by the client portal and the admin print view
 * so the document a client saves is byte-for-byte the one we look at.
 *
 * It renders no navigation of its own: whatever wraps it is responsible for
 * hiding its chrome under `print:`.
 */
export function InvoiceDocument({
  invoice,
  supplier,
  billedTo,
  paymentTermsDays,
}: {
  invoice: InvoiceDocumentData;
  supplier: InvoiceSupplier;
  billedTo: string[];
  paymentTermsDays: number;
}) {
  const rate = vatRatePercent(invoice.subtotalPence, invoice.vatPence);
  const registered = Boolean(supplier.vatNumber);
  // An unregistered supplier must not print a VAT line it cannot charge — but
  // if the invoice does carry VAT (raised before de-registration, say) the
  // amount is still shown, because the totals must add up.
  const showVat = registered || invoice.vatPence > 0;
  const vatLabel = rate === null ? "VAT" : `VAT @ ${rate}%`;

  return (
    <article className="mx-auto max-w-3xl rounded-lg border border-neutral-200 bg-white p-8 print:max-w-none print:border-0 print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-neutral-200 pb-6">
        <div className="text-sm text-neutral-600">
          <p className="text-lg font-semibold tracking-tight text-neutral-900">
            {supplier.legalName ?? supplier.name}
          </p>
          <address className="mt-1 not-italic">
            {supplierLines(supplier).map((line, index) => (
              <span key={`supplier-${index}`} className="block text-xs text-neutral-600">
                {line}
              </span>
            ))}
          </address>
          <p className="mt-2 text-xs text-neutral-600">
            {registered ? `VAT no. ${supplier.vatNumber}` : "VAT not registered"}
          </p>
          {supplier.companyNumber ? (
            <p className="text-xs text-neutral-600">Company no. {supplier.companyNumber}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tracking-tight text-neutral-900">Invoice {invoice.number}</p>
          <p className="mt-1 text-xs text-neutral-500">Issued {formatDate(invoice.issuedAt)}</p>
          <p className="text-xs text-neutral-500">Due {formatDate(invoice.dueAt)}</p>
          <div className="mt-2 flex justify-end">
            <StatusBadge value={invoice.status} />
          </div>
        </div>
      </header>

      <section className="py-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Billed to</h2>
        <address className="mt-2 text-sm not-italic text-neutral-800">
          {billedTo.map((line, index) => (
            <span key={`billed-${index}`} className="block">
              {line}
            </span>
          ))}
        </address>
      </section>

      <section>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit</TableHead>
              {showVat ? <TableHead className="text-right">VAT rate</TableHead> : null}
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.lineItems.map((line, index) => (
              <TableRow key={`${line.description}-${index}`}>
                <TableCell className="text-neutral-900">{line.description}</TableCell>
                <TableCell className="text-right tabular-nums text-neutral-600">{line.quantity}</TableCell>
                <TableCell className="text-right tabular-nums text-neutral-600">
                  {formatPence(line.unitPence, invoice.currency)}
                </TableCell>
                {showVat ? (
                  // The schema holds one VAT total for the invoice, not a rate
                  // per line, so every line carries the same derived rate.
                  <TableCell className="text-right tabular-nums text-neutral-600">
                    {rate === null ? "0%" : `${rate}%`}
                  </TableCell>
                ) : null}
                <TableCell className="text-right tabular-nums text-neutral-900">
                  {formatPence(line.unitPence * line.quantity, invoice.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="mt-6 flex justify-end">
        <dl className="w-full max-w-xs space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">Subtotal</dt>
            <dd className="tabular-nums text-neutral-800">{formatPence(invoice.subtotalPence, invoice.currency)}</dd>
          </div>
          {showVat ? (
            <div className="flex justify-between">
              <dt className="text-neutral-500">{vatLabel}</dt>
              <dd className="tabular-nums text-neutral-800">{formatPence(invoice.vatPence, invoice.currency)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-neutral-200 pt-2">
            <dt className="font-semibold text-neutral-900">Total</dt>
            <dd className="tabular-nums font-semibold text-neutral-900">
              {formatPence(invoice.totalPence, invoice.currency)}
            </dd>
          </div>
        </dl>
      </section>

      <footer className="mt-8 space-y-1 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        <p>Payment terms: {paymentTermsDays} days.</p>
        {supplier.invoiceFooter ? <p className="whitespace-pre-line">{supplier.invoiceFooter}</p> : null}
      </footer>
    </article>
  );
}
