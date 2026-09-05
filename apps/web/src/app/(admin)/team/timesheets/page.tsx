import { formatMinutes, listTimesheet, type MemberTimesheet, teamTimesheets } from "@launchos/core";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { sessionPermissions } from "@/lib/permissions";
import { requireAdmin } from "@/lib/session";
import { MemberEntries } from "./member-entries";
import { dayShort, weekFromParam, weekLabel, weekNav } from "./week";

export const dynamic = "force-dynamic";

/** The grid: a member, a cell per London day, the week's total, and whether they are on the clock now. */
function columns(days: readonly string[]): readonly DataListColumn<MemberTimesheet>[] {
  return [
    {
      key: "member",
      header: "Member",
      primary: true,
      cell: (row) => (
        <>
          {row.name}
          <span className="block text-meta font-normal capitalize text-muted-foreground">{row.role}</span>
        </>
      ),
    },
    ...days.map(
      (day, index): DataListColumn<MemberTimesheet> => ({
        key: day,
        header: dayShort(day),
        numeric: true,
        hideOnMobile: true,
        cell: (row) => {
          const minutes = row.dayMinutes[index] ?? 0;
          return minutes === 0 ? <span className="text-muted-foreground/60">—</span> : formatMinutes(minutes);
        },
      }),
    ),
    {
      key: "total",
      header: "Total",
      numeric: true,
      className: "font-medium text-foreground",
      cell: (row) => formatMinutes(row.totalMinutes),
    },
    {
      key: "status",
      header: "Now",
      status: true,
      cell: (row) => (row.running ? <StatusBadge value="running" tone="info" /> : null),
    },
  ];
}

function WeekPicker({ weekStart }: { weekStart: string }) {
  const nav = weekNav(weekStart);
  return (
    <nav aria-label="Week" className="flex flex-wrap items-center gap-2">
      <Button asChild variant="secondary" size="sm">
        <Link href={`/team/timesheets?week=${nav.previous}`} aria-label="Previous week">
          <ChevronLeft aria-hidden strokeWidth={1.75} />
          <span className="sm:hidden">Previous</span>
        </Link>
      </Button>
      <span className="text-sm font-medium tabular-nums">{weekLabel(weekStart)}</span>
      <Button asChild variant="secondary" size="sm">
        <Link href={`/team/timesheets?week=${nav.next}`} aria-label="Next week">
          <span className="sm:hidden">Next</span>
          <ChevronRight aria-hidden strokeWidth={1.75} />
        </Link>
      </Button>
      {nav.isThisWeek ? null : (
        <Button asChild variant="ghost" size="sm">
          <Link href="/team/timesheets">This week</Link>
        </Button>
      )}
    </nav>
  );
}

export default async function TimesheetsPage({ searchParams }: PageProps<"/team/timesheets">) {
  const [session, permissions, params] = await Promise.all([requireAdmin(), sessionPermissions(), searchParams]);
  const weekStart = weekFromParam(params.week);
  const db = getDb();
  const org = session.organisationId;

  // The owner and anyone with `settings` see the whole team; everyone else
  // sees their own week and nothing about anybody else's.
  const seesTeam = session.role === "owner" || permissions.settings;
  const team = await teamTimesheets(db, org, { weekStart });
  const members = seesTeam ? team.members : team.members.filter((member) => member.userId === session.userId);
  const sheets = await Promise.all(members.map((member) => listTimesheet(db, org, { userId: member.userId, weekStart })));
  const total = members.reduce((sum, member) => sum + member.totalMinutes, 0);

  return (
    <>
      <PageHeader
        title="Timesheets"
        description={
          seesTeam
            ? "Hours clocked per member, by London day. A running entry counts up to now."
            : "Your hours this week, by London day. A running entry counts up to now."
        }
        category="organisation"
        actions={<WeekPicker weekStart={weekStart} />}
      />

      <p className="mb-4 text-sm text-muted-foreground">
        {seesTeam ? "Organisation total" : "Your total"} this week:{" "}
        <span className="font-medium tabular-nums text-foreground" data-testid="week-total">
          {formatMinutes(total)}
        </span>
      </p>

      <DataList
        rows={members}
        columns={columns(team.days)}
        getRowKey={(row) => row.userId}
        caption={`Hours for the week of ${weekLabel(weekStart)}`}
        empty={<EmptyState icon={Clock}>No active members to show.</EmptyState>}
      />

      <Section title="Entries" description="Every entry that started this week: when, for how long, and against what.">
        {members.length === 0 ? (
          <EmptyState icon={Clock}>Nothing to list.</EmptyState>
        ) : (
          <div className="divide-y">
            {members.map((member, index) => (
              <MemberEntries key={member.userId} name={member.name} sheet={sheets[index]!} open={members.length === 1} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
