import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * The printable invoice. The page renders a plain white document with no
 * navigation chrome inside the print area: a client saves it as a PDF through
 * the browser's own print dialog, because a sandboxed page cannot start a
 * download itself.
 */
export default async function PortalInvoicePage({ params }: PageProps<"/portal/invoices/[id]">) {
  const session = await requireClient();
  const { id } = await params;

  // A non-uuid would reach Postgres as a cast error rather than a miss, so it
  // becomes the same 404 as any id that is not this client's.
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();

  const db = getDb();
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.id, parsedId.data),
        eq(schema.invoices.organisationId, session.organisationId),
        // The scope that matters: another client's invoice id is a 404 here,
        // never a document the wrong person gets to read. Drafts are invisible
        // for the same reason they are absent from the list.
        eq(schema.invoices.clientId, session.clientId),
        ne(schema.invoices.status, "draft"),
      ),
    );
  if (!invoice) notFound();

  const [[client], [profile]] = await Promise.all([
    db.select().from(schema.clients).where(eq(schema.clients.id, invoice.clientId)),
    db
      .select()
      .from(schema.billingProfiles)
      .where(
        and(
          eq(schema.billingProfiles.organisationId, session.organisationId),
          eq(schema.billingProfiles.clientId, invoice.clientId),
        ),
      ),
  ]);

  const billedTo = [
    profile?.billingName ?? client?.name ?? session.clientName,
    profile?.addressLine1,
    profile?.addressLine2,
    profile?.city,
    profile?.postcode,
    profile?.country,
    profile?.vatNumber ? `VAT ${profile.vatNumber}` : null,
  ].filter((line): line is string => Boolean(line));

  return (
    <>
      <div className="mb-6 print:hidden">
        <Link href="/portal/invoices" className="text-sm text-neutral-600 hover:underline">
          Back to invoices
        </Link>
        <p className="mt-2 text-xs text-neutral-500">
          Use your browser&rsquo;s print dialog to save this invoice as a PDF.
        </p>
      </div>

      <article className="mx-auto max-w-3xl rounded-lg border border-neutral-200 bg-white p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-neutral-200 pb-6">
          <div>
            <p className="text-lg font-semibold tracking-tight text-neutral-900">LaunchFlow</p>
            <p className="text-xs text-neutral-500">Powered by LaunchFlow</p>
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
            {billedTo.map((line) => (
              <span key={line} className="block">
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
            <div className="flex justify-between">
              <dt className="text-neutral-500">VAT</dt>
              <dd className="tabular-nums text-neutral-800">{formatPence(invoice.vatPence, invoice.currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-neutral-200 pt-2">
              <dt className="font-semibold text-neutral-900">Total</dt>
              <dd className="tabular-nums font-semibold text-neutral-900">
                {formatPence(invoice.totalPence, invoice.currency)}
              </dd>
            </div>
          </dl>
        </section>

        <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
          Payment terms: {profile?.paymentTermsDays ?? 14} days.
        </footer>
      </article>
    </>
  );
}
