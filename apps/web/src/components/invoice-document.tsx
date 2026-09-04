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

/** What the document says about VAT, decided once so no two blocks disagree. */
export interface VatPresentation {
  /** Whether the VAT total and the per-line rate column are printed at all. */
  showVat: boolean;
  /** The totals-block label: "VAT @ 20%", or plain "VAT" if no rate is derivable. */
  vatLabel: string;
  /** The per-line rate column value. */
  rateLabel: string;
  /** The registration line under the supplier's address. */
  registrationLine: string;
}

/**
 * The single decision behind every VAT string on the document.
 *
 * The two claims a printed invoice makes about VAT — the supplier's
 * registration line and the VAT charged — used to be decided separately, so an
 * unregistered supplier could print "VAT not registered" above a "VAT @ 20%"
 * total. Charging VAT while unregistered is not a formatting problem; it is
 * money the client cannot reclaim. `createInvoiceFromSubscription` now
 * zero-rates an unregistered supplier at source, so that state cannot be
 * created — but an invoice raised before that fix, or before a
 * de-registration, still has to render, and it must not assert two
 * incompatible things. The VAT line follows the invoice (rate > 0), the
 * registration line follows the organisation, and the fourth case is named
 * rather than contradicted.
 */
export function vatPresentation(
  vatNumber: string | null,
  subtotalPence: number,
  vatPence: number,
): VatPresentation {
  const registered = Boolean(vatNumber && vatNumber.trim().length > 0);
  const rate = vatRatePercent(subtotalPence, vatPence);
  const showVat = vatPence > 0;
  return {
    showVat,
    vatLabel: rate === null ? "VAT" : `VAT @ ${rate}%`,
    rateLabel: rate === null ? "0%" : `${rate}%`,
    registrationLine: registered
      ? `VAT no. ${vatNumber}`
      : showVat
        ? "VAT charged — supplier registration not on file"
        : "VAT not registered",
  };
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
  const { showVat, vatLabel, rateLabel, registrationLine } = vatPresentation(
    supplier.vatNumber,
    invoice.subtotalPence,
    invoice.vatPence,
  );

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
          <p className="mt-2 text-xs text-neutral-600">{registrationLine}</p>
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
                  <TableCell className="text-right tabular-nums text-neutral-600">{rateLabel}</TableCell>
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
