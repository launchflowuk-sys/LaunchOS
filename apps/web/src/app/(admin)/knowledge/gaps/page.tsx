import { routeCoverage, type RouteCoverage } from "@launchos/core";
import { BookOpen, CircleCheck, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { HELP_ROUTES, helpRouteLabel } from "@/lib/help-routes";
import { requireAdmin } from "@/lib/session";
import { NAV_GROUPS } from "@/lib/nav";

export const dynamic = "force-dynamic";

export const metadata = { title: "Help coverage" };

/**
 * Which screens have a guide, and which have nothing.
 *
 * This screen exists because of the question it answers: not "what have we
 * written" but "where would somebody be stuck with nowhere to turn". Nobody can
 * predict where an individual gets stuck, so the target is not clever coverage
 * of the hard bits — it is **all of it**, and the only way to finish something
 * like that is to be able to count what is left.
 *
 * Every screen in the sidebar is a row. A screen with no staff guide is the
 * failure case, because staff are who this is for: somebody employed to do the
 * work, who should be able to do it without asking.
 */

type Row = RouteCoverage & { label: string; group: string };

export default async function HelpCoveragePage() {
  const session = await requireAdmin();
  const coverage = await routeCoverage(getDb(), session.organisationId, HELP_ROUTES);

  const groupOf = new Map<string, string>();
  for (const group of NAV_GROUPS) {
    for (const item of group.items) groupOf.set(item.href, group.label);
  }

  const rows: Row[] = coverage.map((row) => ({
    ...row,
    label: helpRouteLabel(row.route),
    group: groupOf.get(row.route) ?? "Other",
  }));

  // Sorted worst first. A list of what is done is a report; a list of what is
  // missing, in the order it should be dealt with, is a piece of work.
  const ordered = [...rows].sort((a, b) => a.staff - b.staff || a.total - b.total || a.label.localeCompare(b.label));
  const withStaffGuide = rows.filter((row) => row.staff > 0).length;
  const withNothing = rows.filter((row) => row.total === 0).length;

  const columns: readonly DataListColumn<Row>[] = [
    {
      key: "screen",
      header: "Screen",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <Link href={row.route} className="font-medium hover:underline">{row.label}</Link>
          <p className="text-meta text-muted-foreground">{row.group}</p>
        </div>
      ),
    },
    { key: "staff", header: "For staff", numeric: true, cell: (row) => row.staff },
    { key: "admin", header: "For you", numeric: true, cell: (row) => row.admin },
    { key: "client", header: "For clients", numeric: true, cell: (row) => row.client, hideOnMobile: true },
    {
      key: "state",
      header: "State",
      status: true,
      cell: (row) =>
        row.staff > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-success-fg">
            <CircleCheck className="size-4" /> Covered
          </span>
        ) : row.total > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-warning-fg">
            <TriangleAlert className="size-4" /> Not for staff
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-danger-fg">
            <TriangleAlert className="size-4" /> Nothing written
          </span>
        ),
    },
    {
      key: "write",
      header: "",
      action: true,
      cell: (row) => (
        <Button asChild variant="secondary" size="sm">
          <Link href={`/knowledge/new?route=${encodeURIComponent(row.route)}`}>
            {row.total === 0 ? "Write one" : "Add another"}
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        wide
        title="Help coverage"
        description="Every screen in the app, and whether somebody standing on it has anything to read."
        category="organisation"
        actions={
          <Button asChild variant="secondary">
            <Link href="/knowledge">All guides</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Screens"
          value={rows.length}
          hint="Everything in the sidebar"
          category="organisation"
          icon={BookOpen}
        />
        <StatCard
          label="Covered for staff"
          value={`${withStaffGuide} of ${rows.length}`}
          hint={
            withStaffGuide >= rows.length
              ? "Every screen has a guide"
              : `${rows.length - withStaffGuide} where staff have nothing to read`
          }
          category="organisation"
          icon={Users}
          attention={withStaffGuide < rows.length}
          attentionTone="warning"
        />
        <StatCard
          label="Nothing at all"
          value={withNothing}
          hint={withNothing === 0 ? "Every screen has something" : "No guide for anybody"}
          category="support"
          icon={TriangleAlert}
          attention={withNothing > 0}
        />
      </div>

      <Section
        title="Every screen"
        description="Worst first. A screen with no staff guide is the one that costs you a phone call."
      >
        <DataList rows={ordered} columns={columns} getRowKey={(row) => row.route} caption="Help coverage by screen" />
      </Section>
    </>
  );
}
