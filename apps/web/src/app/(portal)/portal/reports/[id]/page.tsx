import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { periodLabel } from "../period";

export const dynamic = "force-dynamic";

export default async function PortalReportPage({ params }: PageProps<"/portal/reports/[id]">) {
  const session = await requireClient();
  const { id } = await params;

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();

  const [report] = await getDb()
    .select()
    .from(schema.clientReports)
    .where(
      and(
        eq(schema.clientReports.id, parsedId.data),
        eq(schema.clientReports.organisationId, session.organisationId),
        // Another client's report id is a 404, and an unpublished one is not a
        // document yet — both cases look identical from out here.
        eq(schema.clientReports.clientId, session.clientId),
        eq(schema.clientReports.status, "published"),
      ),
    );
  if (!report) notFound();

  const stats = report.stats;
  const cards: { label: string; value: string }[] = [
    { label: "Tasks done", value: String(stats.tasksDone ?? 0) },
    { label: "Uptime", value: stats.uptimePercent == null ? "—" : `${stats.uptimePercent.toFixed(2)}%` },
    { label: "Tickets resolved", value: String(stats.ticketsResolved ?? 0) },
  ];
  if (stats.ads) cards.push({ label: "Ad ROAS", value: `${stats.ads.roas.toFixed(2)}×` });

  return (
    <>
      <PageHeader
        title={periodLabel(report.periodStart, report.periodEnd)}
        description={`Published ${formatDateTime(report.publishedAt)}`}
        actions={
          <Link href="/portal/reports" className="text-sm text-neutral-600 hover:underline print:hidden">
            Back to reports
          </Link>
        }
      />

      <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-lg border border-neutral-200 bg-white p-4">
            <p className="text-xs text-neutral-500">{card.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-neutral-900">{card.value}</p>
          </div>
        ))}
      </section>

      <article className="rounded-lg border border-neutral-200 bg-white p-6">
        {/* `react-markdown` renders text, not HTML: no rehype-raw, so nothing in
            a summary can inject markup into the portal. */}
        <div className="prose prose-neutral max-w-none">
          <Markdown>{report.summaryMd}</Markdown>
        </div>
      </article>
    </>
  );
}
