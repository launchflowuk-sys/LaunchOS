import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { publishReportAction } from "../actions";

export const dynamic = "force-dynamic";

/** A number the report builder could not compute renders as an em dash, never 0. */
function orDash(value: number | null | undefined, format: (n: number) => string): string {
  return value === null || value === undefined ? "—" : format(value);
}

const count = (n: number) => n.toLocaleString("en-GB");

/**
 * The one currency these rows agree on, or null if they do not agree (or there
 * are none). `client_reports.stats` carries pence with no currency of its own,
 * so the money tiles read it off the rows the figures were summed from rather
 * than assuming sterling — a client billed in EUR was being shown "£4,210.00"
 * for €4,210.00 on a document they are later shown in the portal.
 */
function soleCurrency(rows: { currency: string }[]): string | null {
  const codes = new Set(rows.map((row) => row.currency));
  return codes.size === 1 ? [...codes][0]! : null;
}

interface Tile {
  label: string;
  value: string;
  note?: string;
}

export default async function ReportDetailPage({ params }: PageProps<"/reports/[id]">) {
  const session = await requireAdmin();
  // A malformed segment (`/reports/latest`) is a 404, not the 22P02 Postgres
  // raises when a non-UUID literal reaches a `uuid` column.
  const id = uuidOr404((await params).id);
  const db = getDb();

  const [row] = await db
    .select({ report: schema.clientReports, clientName: schema.clients.name })
    .from(schema.clientReports)
    .innerJoin(schema.clients, eq(schema.clientReports.clientId, schema.clients.id))
    .where(and(eq(schema.clientReports.id, id), eq(schema.clientReports.organisationId, session.organisationId)));
  if (!row) notFound();

  const { report, clientName } = row;
  const stats = report.stats;

  const [adCurrencies, invoiceCurrencies] = await Promise.all([
    db.selectDistinct({ currency: schema.adAccounts.currency }).from(schema.adAccounts).where(and(
      eq(schema.adAccounts.organisationId, session.organisationId),
      eq(schema.adAccounts.clientId, report.clientId),
    )),
    db.selectDistinct({ currency: schema.invoices.currency }).from(schema.invoices).where(and(
      eq(schema.invoices.organisationId, session.organisationId),
      eq(schema.invoices.clientId, report.clientId),
    )),
  ]);
  const adsCurrency = soleCurrency(adCurrencies);
  const invoicesCurrency = soleCurrency(invoiceCurrencies);
  const MIXED = "Summed across more than one currency";

  const tiles: Tile[] = [
    { label: "Tasks done", value: orDash(stats.tasksDone, count) },
    { label: "Tasks open", value: orDash(stats.tasksOpen, count) },
    { label: "Uptime", value: orDash(stats.uptimePercent, (n) => `${n.toFixed(2)}%`) },
    { label: "Tickets opened", value: orDash(stats.ticketsOpened, count) },
    { label: "Tickets resolved", value: orDash(stats.ticketsResolved, count) },
    {
      label: "Ad spend",
      value: orDash(stats.ads?.spendPence, (n) => formatMoney(n, adsCurrency ?? "GBP")),
      ...(adsCurrency === null && adCurrencies.length > 1 ? { note: MIXED } : {}),
    },
    { label: "ROAS", value: orDash(stats.ads?.roas, (n) => n.toFixed(2)) },
    {
      label: "Invoices paid",
      value: orDash(stats.invoices?.paidPence, (n) => formatMoney(n, invoicesCurrency ?? "GBP")),
      ...(invoicesCurrency === null && invoiceCurrencies.length > 1 ? { note: MIXED } : {}),
    },
  ];

  return (
    <>
      <PageHeader
        title={`${clientName} — ${formatDate(report.periodStart)} to ${formatDate(report.periodEnd)}`}
        description={
          report.status === "published"
            ? `Published ${formatDateTime(report.publishedAt)} and visible in the client portal.`
            : "A draft. Publishing makes it visible in the client portal."
        }
        actions={
          report.status === "draft" ? (
            <ActionForm action={publishReportAction} ariaLabel="Publish this report" success="Report published">
              <input type="hidden" name="reportId" value={report.id} />
              <Button type="submit">Publish</Button>
            </ActionForm>
          ) : (
            <StatusBadge value={report.status} />
          )
        }
      />

      <p className="mb-6 text-sm text-neutral-500">
        <Link href="/reports" className="underline">
          All reports
        </Link>{" "}
        ·{" "}
        <Link href={`/clients/${report.clientId}`} className="underline">
          {clientName}
        </Link>
      </p>

      <dl className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-neutral-200 bg-white p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">{tile.label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-neutral-900">{tile.value}</dd>
            {tile.note ? <dd className="mt-1 text-xs text-amber-700">{tile.note}</dd> : null}
          </div>
        ))}
      </dl>

      <section className="rounded-lg border border-neutral-200 bg-white p-6">
        <div className="prose prose-neutral max-w-none">
          <Markdown>{report.summaryMd}</Markdown>
        </div>
      </section>
    </>
  );
}
