import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { PrintButton } from "@/components/portal/print-button";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
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
        description={`Published ${formatDate(report.publishedAt)}`}
        category="money"
        actions={
          <>
            <Button asChild variant="secondary" className="print:hidden">
              <Link href="/portal/reports">
                <ArrowLeft aria-hidden strokeWidth={1.75} />
                Back to reports
              </Link>
            </Button>
            <PrintButton />
          </>
        }
      />

      <section aria-label="Headline figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => (
          <StatCard key={card.label} label={card.label} value={card.value} category="money" />
        ))}
      </section>

      {/* The summary is the document a client may save or forward, so it prints
          as plain text on white with no card around it. */}
      <article className="mt-6 rounded-xl border bg-card p-5 sm:p-8 print:mt-0 print:border-0 print:p-0">
        {/* `react-markdown` renders text, not HTML: no rehype-raw, so nothing in
            a summary can inject markup into the portal. */}
        {/* The page already carries the period as its `h1`, so the summary's own
            headings are capped: `prose` defaults put a 36px title inside a card on
            a 375px phone. */}
        <div className="prose max-w-none text-base text-foreground prose-headings:text-foreground prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-strong:text-foreground prose-a:text-primary">
          <Markdown>{report.summaryMd}</Markdown>
        </div>
      </article>
    </>
  );
}
