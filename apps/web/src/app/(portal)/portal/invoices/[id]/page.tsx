import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { InvoiceDocument } from "@/components/invoice-document";
import { PrintButton } from "@/components/portal/print-button";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * The printable invoice. The page renders a plain white document with no
 * navigation chrome inside the print area: a client saves it as a PDF through
 * the browser's own print dialog, because a sandboxed page cannot start a
 * download itself. The portal shell around it is `print:hidden`, so the saved
 * PDF carries no menu bar and no portal user's email address.
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

  const [[client], [profile], [organisation]] = await Promise.all([
    db
      .select()
      .from(schema.clients)
      .where(
        and(
          eq(schema.clients.id, invoice.clientId),
          // Redundant given the invoice was already matched on both scopes,
          // but this query must not be the one that still returns a row if
          // the scoping above it is ever loosened.
          eq(schema.clients.organisationId, session.organisationId),
        ),
      ),
    db
      .select()
      .from(schema.billingProfiles)
      .where(
        and(
          eq(schema.billingProfiles.organisationId, session.organisationId),
          eq(schema.billingProfiles.clientId, invoice.clientId),
        ),
      ),
    db.select().from(schema.organisations).where(eq(schema.organisations.id, session.organisationId)),
  ]);
  if (!organisation) notFound();

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
      {/* Every bit of this bar is chrome: it is `print:hidden` so the saved PDF
          is the document and nothing else. */}
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <Button asChild variant="secondary">
          <Link href="/portal/invoices">
            <ArrowLeft aria-hidden strokeWidth={1.75} />
            Back to invoices
          </Link>
        </Button>
        {/* The PDF we sent them, when it exists. It sits before the print
            button and is named for what makes it different: printing produces
            a copy of this page, while this is the file their bookkeeper was
            already emailed, with our reference in its footer. Absent rather
            than disabled when it has not been rendered — printing still gets
            them a document. */}
        {invoice.documentId ? (
          <Button asChild variant="secondary">
            <a href={`/api/documents/${invoice.documentId}`}>The PDF we sent you</a>
          </Button>
        ) : null}
        <PrintButton />
      </div>

      <InvoiceDocument
        invoice={invoice}
        supplier={organisation}
        billedTo={billedTo}
        paymentTermsDays={profile?.paymentTermsDays ?? 14}
      />
    </>
  );
}
