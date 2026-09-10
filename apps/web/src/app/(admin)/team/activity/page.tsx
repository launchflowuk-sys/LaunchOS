import { listStaffActivity, type ActivityRow } from "@launchos/core";
import { Activity, Users, Layers } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { helpRouteLabel } from "@/lib/help-routes";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Team activity" };

/** Fourteen days: long enough to show a pattern, short enough to be about now. */
const WINDOW_DAYS = 14;

/**
 * What the team has been working on.
 *
 * The timesheet says somebody was here for seven hours; it cannot say what
 * those hours went into. This is the other half — which screens a member worked
 * from, counted per day.
 *
 * **A staff member sees their own, and only their own.** Two reasons, and the
 * second matters more. Covert monitoring of employees is a transparency problem
 * under UK GDPR, so a person being measured should be able to read the measure.
 * And a team that discovers it is being watched silently stops trusting the
 * tool doing the watching, which costs more than the insight is worth.
 */
export default async function TeamActivityPage() {
  const session = await requireAdmin();
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const isOwner = session.role === "owner";

  const rows = await listStaffActivity(
    getDb(),
    session.organisationId,
    since,
    isOwner ? undefined : session.userId,
  );

  const people = new Set(rows.map((row) => row.userId)).size;
  const views = rows.reduce((total, row) => total + row.views, 0);

  const columns: readonly DataListColumn<ActivityRow>[] = [
    {
      key: "screen",
      header: "Screen",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium">{helpRouteLabel(row.route)}</p>
          <p className="text-meta text-muted-foreground">{row.route}</p>
        </div>
      ),
    },
    ...(isOwner
      ? [{
          key: "who",
          header: "Who",
          cell: (row: ActivityRow) => row.name ?? row.email,
        } satisfies DataListColumn<ActivityRow>]
      : []),
    { key: "views", header: "Opened", numeric: true, cell: (row) => row.views },
    {
      key: "last",
      header: "Last",
      className: "whitespace-nowrap",
      hideOnMobile: true,
      cell: (row) => formatDateTime(row.lastAt),
    },
  ];

  return (
    <>
      <PageHeader
        wide
        title={isOwner ? "Team activity" : "Your activity"}
        description={
          isOwner
            ? `Which screens the team has worked from over the last ${WINDOW_DAYS} days.`
            : `Which screens you have worked from over the last ${WINDOW_DAYS} days. Your manager sees the same.`
        }
        category="organisation"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Screens used" value={rows.length} hint={`Over ${WINDOW_DAYS} days`} category="organisation" icon={Layers} />
        <StatCard label="Times opened" value={views} hint="Across every screen" category="organisation" icon={Activity} />
        {isOwner ? (
          <StatCard label="People" value={people} hint="With activity in the window" category="delivery" icon={Users} />
        ) : null}
      </div>

      <Section title="Busiest first" description="Counted per screen per day, not per click.">
        <DataList
          rows={rows}
          columns={columns}
          getRowKey={(row) => `${row.userId}:${row.route}`}
          caption="Screens worked from"
          empty={
            <EmptyState icon={Activity} title="Nothing recorded yet">
              Activity appears here as people move around the app.
            </EmptyState>
          }
        />
      </Section>
    </>
  );
}
