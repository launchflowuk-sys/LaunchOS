import { latestOpsBrief, listOpsBriefs, type OpsBrief } from "@launchos/core";
import { Sunrise } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { BriefArticle } from "./brief-article";
import { briefDateLabel } from "./format";
import { WriteBriefButton } from "./write-brief-button";

export const dynamic = "force-dynamic";

/** Enough mornings to see a month at a glance; the agent writes one a day. */
const HISTORY_LIMIT = 30;

const COLUMNS: readonly DataListColumn<OpsBrief>[] = [
  { key: "date", header: "Morning", primary: true, cell: (row) => briefDateLabel(row.briefDate) },
  {
    key: "needs",
    header: "Needs you",
    cell: (row) =>
      row.highlights.length === 0 ? (
        <span className="text-success-fg">Nothing</span>
      ) : (
        row.highlights.map((h) => h.label).join(" · ")
      ),
  },
  { key: "written", header: "Written", numeric: true, hideOnMobile: true, cell: (row) => formatDateTime(row.createdAt) },
  {
    key: "open",
    header: "Open",
    action: true,
    cell: (row) => (
      <Button asChild variant="secondary" size="sm">
        <Link href={`/briefs/${row.id}`}>Read</Link>
      </Button>
    ),
  },
];

export default async function BriefsPage() {
  const session = await requireAdmin();
  const db = getDb();
  const [latest, history] = await Promise.all([
    latestOpsBrief(db, session.organisationId),
    listOpsBriefs(db, session.organisationId, { limit: HISTORY_LIMIT }),
  ]);

  return (
    <>
      <PageHeader
        title="Briefs"
        description="The Ops Brief agent reads the last day and the open state at 07:00 and writes what needs you. Re-running today replaces today's."
        category="automation"
        actions={<WriteBriefButton />}
      />

      <Section title="Latest">
        {latest ? (
          <BriefArticle brief={latest} />
        ) : (
          <EmptyState icon={Sunrise} action={<WriteBriefButton />}>
            No brief yet. The first one is written at 07:00 tomorrow, or write today&apos;s now.
          </EmptyState>
        )}
      </Section>

      <Section title="History" description="One brief per morning, newest first.">
        <DataList
          rows={history.filter((row) => row.id !== latest?.id)}
          columns={COLUMNS}
          getRowKey={(row) => row.id}
          caption="Earlier briefs"
          empty={<EmptyState icon={Sunrise}>Earlier mornings will list here.</EmptyState>}
        />
      </Section>
    </>
  );
}
