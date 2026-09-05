import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { InvoiceDocument } from "@/components/invoice-document";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The same printable invoice the client sees in their portal, for staff.
 *
 * It exists because most clients never sign in: an invoice still has to be
 * saved as a PDF and emailed, and it must be the identical document — same
 * supplier block, same VAT rate label, same footer — rather than a second
 * rendering that can drift from the one the client reads. The admin shell's
 * sidebar, search bar and footer are `print:hidden`, so what prints is the
 * document alone. Drafts are included here (unlike the portal): raising an
 * invoice and reading it back before it is sent is the point of the screen.
 */
export default async function AdminInvoicePrintPage({ params }: PageProps<"/invoices/[id]/print">) {
  const session = await requireAdmin();
  const { id } = await params;

  // A non-uuid reaches Postgres as a cast error rather than a miss, so it is
  // parsed here and becomes an ordinary 404.
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
    profile?.billingName ?? client?.name ?? "Unknown client",
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
        <Link
          href={`/invoices/${invoice.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          <ChevronLeft aria-hidden strokeWidth={1.75} className="size-4" />
          Back to {invoice.number}
        </Link>
        <p className="mt-2 text-meta text-muted-foreground">
          Use your browser&rsquo;s print dialog to save this invoice as a PDF. Supplier details come from{" "}
          <Link href="/settings/organisation" className="underline">
            Settings &rarr; Organisation
          </Link>
          .
        </p>
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
