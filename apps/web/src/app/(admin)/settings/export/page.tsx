import { EXPORTABLE } from "@launchos/core";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { requirePermission } from "@/lib/permissions";
import { forbidden } from "next/navigation";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<string, string> = {
  clients: "Every client with its slug, email and status.",
  invoices: "Every invoice with its client, dates and total in pounds.",
  payments: "Every payment with its client, provider reference and amount.",
  subscriptions: "Every subscription with its package, monthly amount and current period.",
  sites: "Every website with its client and primary URL.",
  domains: "Every domain with its client, registrar and expiry.",
  tasks: "Every task with its client, status and due date.",
  leads: "Every lead with its source and status.",
};

/**
 * Getting the data out.
 *
 * One CSV per module rather than one archive of everything: "send me the
 * invoices" is the request people actually make, and a CSV opens in the
 * spreadsheet they already have.
 *
 * Import is deliberately absent rather than greyed out — see the note on the
 * page, and the longer one in `packages/core/src/exports/export-data.ts`.
 */
export default async function ExportPage() {
  const gate = await requirePermission("settings");
  if (!gate.ok) forbidden();

  return (
    <>
      <PageHeader
        title="Export"
        description="Download any module as a CSV. Money is exported in pounds, dates in ISO format."
        category="organisation"
      />

      <Section title="Modules">
        <div className="grid gap-3 sm:grid-cols-2">
          {EXPORTABLE.map((module) => (
            <a
              key={module}
              href={`/api/export/${module}`}
              className="flex items-center gap-4 rounded-[20px] border bg-card p-5 transition-colors hover:bg-primary-soft/60"
            >
              <Download aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block font-medium capitalize">{module}</span>
                <span className="block text-meta text-muted-foreground">{DESCRIPTIONS[module]}</span>
              </span>
            </a>
          ))}
        </div>
      </Section>

      <Section title="Importing">
        <div className="rounded-[20px] border bg-card p-5">
          <p className="text-row text-muted-foreground">
            There is no import yet, and no half-working button pretending otherwise. Reading a CSV is the easy part;
            the rest is deciding what happens when a row already exists, when a client name matches two clients, when
            an invoice number collides with the live sequence, and what a half-applied import leaves behind when row
            four hundred fails. Those are decisions about the business, not the code, and they differ per module —
            importing leads is nearly free, importing invoices touches a number sequence and a ledger.
          </p>
          <p className="mt-3 text-row text-muted-foreground">
            When it is built it wants a dry run that reports what would change before anything does, and one
            transaction per file so a failure leaves nothing behind.
          </p>
        </div>
      </Section>
    </>
  );
}
