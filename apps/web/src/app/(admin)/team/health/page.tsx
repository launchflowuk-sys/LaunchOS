import {
  CSAT_LOW_SCORE,
  csatSummary,
  DEFAULT_FIRST_RESPONSE_HOURS,
  formatMinutes,
  type MemberHealth,
  teamHealth,
} from "@launchos/core";
import { AlarmClock, HeartPulse, ListChecks, MessageSquare, Siren, Star } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/empty-state";
import { InlineAlert } from "@/components/inline-alert";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard, type StatCardProps } from "@/components/stat-card";
import { getDb } from "@/lib/db";
import { sessionPermissions } from "@/lib/permissions";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;
/** The first-response target, in minutes, that the organisation line is measured against. */
const SLA_MINUTES = DEFAULT_FIRST_RESPONSE_HOURS * 60;

function median(minutes: number | null): string {
  return minutes === null ? "—" : formatMinutes(minutes);
}

/** A member's health line with their CSAT over the same window laid alongside. */
type MemberRow = MemberHealth & { csatAverage: number | null; csatResponses: number };

/** "4.5 (3)" — the mean and how many ratings it rests on; "—" with none. */
function csatCell(average: number | null, responses: number) {
  if (average === null) return "—";
  const text = `${average.toFixed(1)} (${responses})`;
  return average <= CSAT_LOW_SCORE ? <span className="text-danger-fg">{text}</span> : text;
}

const COLUMNS: readonly DataListColumn<MemberRow>[] = [
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
  { key: "assigned", header: "Cases assigned", numeric: true, cell: (row) => row.casesAssigned },
  { key: "resolved", header: "Cases resolved", numeric: true, cell: (row) => row.casesResolved },
  {
    key: "response",
    header: "Median first response",
    numeric: true,
    cell: (row) =>
      row.medianFirstResponseMinutes !== null && row.medianFirstResponseMinutes > SLA_MINUTES ? (
        <span className="text-danger-fg">{median(row.medianFirstResponseMinutes)}</span>
      ) : (
        median(row.medianFirstResponseMinutes)
      ),
  },
  {
    key: "overdue",
    header: "Overdue tasks",
    numeric: true,
    cell: (row) => (row.overdueTasks > 0 ? <span className="text-danger-fg">{row.overdueTasks}</span> : row.overdueTasks),
  },
  {
    key: "hours",
    header: "Hours clocked",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => row.hoursClocked.toFixed(1),
  },
  { key: "csat", header: "CSAT", numeric: true, cell: (row) => csatCell(row.csatAverage, row.csatResponses) },
];

export default async function TeamHealthPage() {
  const [session, permissions] = await Promise.all([requireAdmin(), sessionPermissions()]);
  const [health, csat] = await Promise.all([
    teamHealth(getDb(), session.organisationId, { days: WINDOW_DAYS }),
    csatSummary(getDb(), session.organisationId, { days: WINDOW_DAYS }),
  ]);
  const csatByMember = new Map(csat.members.map((m) => [m.userId, m]));
  const withCsat = (m: MemberHealth): MemberRow => ({
    ...m,
    csatAverage: csatByMember.get(m.userId)?.average ?? null,
    csatResponses: csatByMember.get(m.userId)?.responses ?? 0,
  });

  // The owner and anyone with `settings` read the whole team; everyone else
  // reads their own line only — the rail hides the page for them, but a
  // typed URL still lands here.
  const seesTeam = session.role === "owner" || permissions.settings;
  const members = (seesTeam ? health.members : health.members.filter((m) => m.userId === session.userId)).map(withCsat);
  const { organisation } = health;

  const tiles: readonly StatCardProps[] = [
    {
      label: "Open cases",
      value: organisation.openCases,
      href: "/cases",
      hint: "Not resolved or closed",
      category: "support",
      icon: MessageSquare,
    },
    {
      label: "Open tasks",
      value: organisation.openTasks,
      href: "/tasks",
      hint: "Not done or cancelled",
      category: "delivery",
      icon: ListChecks,
    },
    {
      label: "Overdue tasks",
      value: organisation.overdueTasks,
      href: "/tasks",
      hint: "Past their due date",
      category: "delivery",
      icon: AlarmClock,
      attention: true,
    },
    {
      label: "Open incidents",
      value: organisation.openIncidents,
      href: "/incidents",
      hint: "Open or acknowledged",
      category: "support",
      icon: Siren,
      attention: true,
    },
    {
      label: "CSAT",
      value: csat.organisation.average === null ? "—" : csat.organisation.average.toFixed(1),
      href: "/cases",
      hint:
        csat.organisation.invited === 0
          ? "No resolved case has been asked yet"
          : `${csat.organisation.responses} of ${csat.organisation.invited} asked replied`,
      category: "support",
      icon: Star,
      attention: csat.organisation.average !== null && csat.organisation.average <= CSAT_LOW_SCORE,
    },
  ];

  const insideSla = organisation.medianFirstResponseMinutes !== null && organisation.medianFirstResponseMinutes <= SLA_MINUTES;

  return (
    <>
      <PageHeader
        title="Health"
        description={`How the team is doing over the last ${WINDOW_DAYS} days: cases, response times, overdue work and hours.`}
        category="organisation"
      />

      {organisation.medianFirstResponseMinutes === null ? (
        <InlineAlert tone="info" title="No first-response figure yet">
          No case was answered for the first time in the last {WINDOW_DAYS} days, so there is nothing to measure against the{" "}
          {DEFAULT_FIRST_RESPONSE_HOURS}-hour target.
        </InlineAlert>
      ) : (
        <InlineAlert
          tone={insideSla ? "success" : "danger"}
          title={`Median first response ${formatMinutes(organisation.medianFirstResponseMinutes)} — ${insideSla ? "inside" : "outside"} the ${DEFAULT_FIRST_RESPONSE_HOURS}-hour target`}
        >
          Across {organisation.casesAnswered} {organisation.casesAnswered === 1 ? "case" : "cases"} first answered in the last{" "}
          {WINDOW_DAYS} days.
        </InlineAlert>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <StatCard key={tile.label} {...tile} />
        ))}
      </div>

      <Section
        title={seesTeam ? "By member" : "You"}
        description="Cases counted when opened or resolved in the window; overdue tasks are as of now; hours are entries started in the window; CSAT is the mean client score (1–5) on cases rated in the window, with the number of ratings."
      >
        <DataList
          rows={members}
          columns={COLUMNS}
          getRowKey={(row) => row.userId}
          caption={`Team health, last ${WINDOW_DAYS} days`}
          empty={<EmptyState icon={HeartPulse}>No active members to report on.</EmptyState>}
        />
      </Section>
    </>
  );
}
