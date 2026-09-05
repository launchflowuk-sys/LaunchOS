import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
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
        category="money"
        actions={
          report.status === "draft" ? (
            <ActionForm action={publishReportAction} ariaLabel="Publish this report" success="Report published">
              <input type="hidden" name="reportId" value={report.id} />
              <Button type="submit">Publish</Button>
            </ActionForm>
          ) : (
            // Wrapped: PageHeader stretches its actions under `sm`, and a pill
            // that is 343px wide reads as a button, not a state.
            <div>
              <StatusBadge value={report.status} />
            </div>
          )
        }
      />

      <p className="mb-6 text-sm text-muted-foreground">
        <Link href="/reports" className="underline hover:text-foreground">
          All reports
        </Link>{" "}
        ·{" "}
        <Link href={`/clients/${report.clientId}`} className="underline hover:text-foreground">
          {clientName}
        </Link>
      </p>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="min-w-0 rounded-xl border bg-card p-4">
            <dt className="label-caps text-muted-foreground">{tile.label}</dt>
            <dd className="mt-2 text-lg leading-none font-semibold tabular-nums">{tile.value}</dd>
            {tile.note ? <dd className="mt-2 text-meta text-warning-fg">{tile.note}</dd> : null}
          </div>
        ))}
      </dl>

      <Section title="Summary">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-sm text-foreground">
            <Markdown>{report.summaryMd}</Markdown>
          </div>
        </div>
      </Section>
    </>
  );
}
