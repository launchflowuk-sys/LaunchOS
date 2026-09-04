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
import { formatDate, formatDateTime, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { publishReportAction } from "../actions";

export const dynamic = "force-dynamic";

/** A number the report builder could not compute renders as an em dash, never 0. */
function orDash(value: number | null | undefined, format: (n: number) => string): string {
  return value === null || value === undefined ? "—" : format(value);
}

const count = (n: number) => n.toLocaleString("en-GB");

export default async function ReportDetailPage({ params }: PageProps<"/reports/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;

  const [row] = await getDb()
    .select({ report: schema.clientReports, clientName: schema.clients.name })
    .from(schema.clientReports)
    .innerJoin(schema.clients, eq(schema.clientReports.clientId, schema.clients.id))
    .where(and(eq(schema.clientReports.id, id), eq(schema.clientReports.organisationId, session.organisationId)));
  if (!row) notFound();

  const { report, clientName } = row;
  const stats = report.stats;

  const tiles = [
    ["Tasks done", orDash(stats.tasksDone, count)],
    ["Tasks open", orDash(stats.tasksOpen, count)],
    ["Uptime", orDash(stats.uptimePercent, (n) => `${n.toFixed(2)}%`)],
    ["Tickets opened", orDash(stats.ticketsOpened, count)],
    ["Tickets resolved", orDash(stats.ticketsResolved, count)],
    ["Ad spend", orDash(stats.ads?.spendPence, (n) => formatPence(n))],
    ["ROAS", orDash(stats.ads?.roas, (n) => n.toFixed(2))],
    ["Invoices paid", orDash(stats.invoices?.paidPence, (n) => formatPence(n))],
  ] as const;

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
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-neutral-200 bg-white p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-neutral-900">{value}</dd>
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
