import { latestOpsBrief, listActivity, listTasks } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray } from "drizzle-orm";
import {
  AlarmClock,
  CalendarClock,
  Link2,
  ListChecks,
  MessageSquare,
  Rocket,
  ShieldCheck,
  Siren,
} from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard, type StatCardProps } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { isInAppPath } from "@/lib/in-app-path";
import { requireAdmin } from "@/lib/session";
import { BriefCard } from "./briefs/brief-card";

export const dynamic = "force-dynamic";

const OPEN_TICKET_STATUSES = ["open", "triaged", "in_progress", "waiting_client"] as const;
const UNRESOLVED_INCIDENT_STATUSES = ["open", "acknowledged"] as const;
const UNFINISHED_TASK_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;
const FINISHED_TASK_STATUSES = ["done", "cancelled"] as const;

const WEEK_MS = 7 * 86_400_000;
/** Enough to see the shape of the day without turning the dashboard into a list screen. */
const NEEDS_YOU_LIMIT = 5;
const ACTIVITY_LIMIT = 8;

type ApprovalRow = { id: string; title: string; kind: string; createdAt: Date };
type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];
type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];

const APPROVAL_COLUMNS: readonly DataListColumn<ApprovalRow>[] = [
  { key: "title", header: "Waiting on you", primary: true, cell: (row) => row.title },
  { key: "kind", header: "Kind", cell: (row) => row.kind.replaceAll("_", " ") },
  { key: "requested", header: "Requested", cell: (row) => formatDateTime(row.createdAt) },
  { key: "status", header: "Status", status: true, cell: () => <StatusBadge value="pending" /> },
  {
    key: "action",
    header: "Decide",
    action: true,
    cell: () => (
      <Button asChild variant="secondary" size="sm">
        <Link href="/approvals">Decide</Link>
      </Button>
    ),
  },
];

const TASK_COLUMNS: readonly DataListColumn<TaskRow>[] = [
  {
    key: "title",
    header: "Task",
    primary: true,
    cell: (row) => (
      <Link href={`/tasks/${row.id}`} className="hover:underline">
        {row.title}
      </Link>
    ),
  },
  { key: "client", header: "Client", cell: (row) => row.clientName },
  { key: "due", header: "Due", numeric: true, cell: (row) => formatDate(row.dueAt) },
  {
    key: "assignee",
    header: "Assignee",
    hideOnMobile: true,
    cell: (row) => row.assigneeName ?? "Unassigned",
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

const ACTIVITY_COLUMNS: readonly DataListColumn<ActivityRow>[] = [
  {
    key: "title",
    header: "What happened",
    primary: true,
    cell: (row) =>
      isInAppPath(row.link) ? (
        <Link href={row.link} className="hover:underline">
          {row.title}
        </Link>
      ) : (
        row.title
      ),
  },
  { key: "kind", header: "Kind", cell: (row) => row.kind.replaceAll("_", " ") },
  { key: "when", header: "When", numeric: true, cell: (row) => formatDateTime(row.createdAt) },
];

export default async function DashboardPage() {
  const session = await requireAdmin();
  const db = getDb();
  const org = session.organisationId;

  const now = new Date();
  const weekEnd = new Date(now.getTime() + WEEK_MS);

  const [
    openIncidents,
    pendingApprovals,
    openTickets,
    overdueTasks,
    dueThisWeek,
    onboarding,
    approvalQueue,
    overdueQueue,
    activity,
    brief,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(schema.incidents)
      .where(
        and(
          eq(schema.incidents.organisationId, org),
          inArray(schema.incidents.status, [...UNRESOLVED_INCIDENT_STATUSES]),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, org), eq(schema.approvals.status, "pending"))),
    db
      .select({ value: count() })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.organisationId, org), inArray(schema.tickets.status, [...OPEN_TICKET_STATUSES]))),
    db
      .select({ value: count() })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.organisationId, org),
          isNotNull(schema.tasks.dueAt),
          lt(schema.tasks.dueAt, now),
          notInArray(schema.tasks.status, [...FINISHED_TASK_STATUSES]),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.organisationId, org),
          gte(schema.tasks.dueAt, now),
          lte(schema.tasks.dueAt, weekEnd),
          inArray(schema.tasks.status, [...UNFINISHED_TASK_STATUSES]),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.clients)
      .where(
        and(
          eq(schema.clients.organisationId, org),
          isNotNull(schema.clients.packageId),
          isNull(schema.clients.onboardedAt),
        ),
      ),
    // The rows behind the two "needs you" numbers, so the dashboard can be
    // acted on rather than only read.
    db
      .select({
        id: schema.approvals.id,
        title: schema.approvals.title,
        kind: schema.approvals.kind,
        createdAt: schema.approvals.createdAt,
      })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, org), eq(schema.approvals.status, "pending")))
      .orderBy(desc(schema.approvals.createdAt))
      .limit(NEEDS_YOU_LIMIT),
    listTasks(db, org, {
      status: [...UNFINISHED_TASK_STATUSES],
      dueTo: now,
      sort: "due",
      limit: NEEDS_YOU_LIMIT,
    }),
    listActivity(db, org, { limit: ACTIVITY_LIMIT }),
    latestOpsBrief(db, org),
  ]);

  // Attention-first: the three counts that mean a person has to do something
  // lead, and they take the semantic tint the moment they are above zero. The
  // three behind them are context and keep their category hue.
  const cards: readonly StatCardProps[] = [
    {
      label: "Pending approvals",
      value: pendingApprovals[0]?.value ?? 0,
      href: "/approvals",
      hint: "Waiting on a human decision",
      category: "automation",
      icon: ShieldCheck,
      attention: true,
      // Waiting on a decision is a queue, not a failure — DESIGN.md pairs
      // pending approval with warning, and open incidents with danger.
      attentionTone: "warning",
    },
    {
      label: "Open incidents",
      value: openIncidents[0]?.value ?? 0,
      href: "/incidents",
      hint: "Open or acknowledged",
      category: "support",
      icon: Siren,
      attention: true,
      attentionTone: "danger",
    },
    {
      label: "Overdue tasks",
      value: overdueTasks[0]?.value ?? 0,
      href: "/tasks",
      hint: "Past their due date",
      category: "delivery",
      icon: AlarmClock,
      attention: true,
      attentionTone: "danger",
    },
    {
      label: "Open cases",
      value: openTickets[0]?.value ?? 0,
      href: "/cases",
      hint: "Not resolved or closed",
      category: "support",
      icon: MessageSquare,
      attention: false,
    },
    {
      label: "Due this week",
      value: dueThisWeek[0]?.value ?? 0,
      href: "/tasks",
      hint: "Next seven days",
      category: "delivery",
      icon: CalendarClock,
      attention: false,
    },
    {
      label: "Onboarding in progress",
      value: onboarding[0]?.value ?? 0,
      href: "/clients",
      hint: "On a package, not handed over",
      category: "delivery",
      icon: Rocket,
      attention: false,
    },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="What needs attention right now." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {cards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      <Section title="This morning's brief" description="What the Ops Brief agent saw at 07:00, and what it says needs you.">
        <BriefCard brief={brief} />
      </Section>

      <Section
        title="Waiting on a decision"
        description="Nothing here reaches a client, moves money or changes DNS until you release it."
      >
        <DataList
          rows={approvalQueue}
          columns={APPROVAL_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Approvals waiting on a decision"
          empty={
            <EmptyState icon={ShieldCheck}>
              Nothing is waiting for a decision. Agents park outward actions here before they happen.
            </EmptyState>
          }
        />
      </Section>

      <Section title="Overdue tasks" description="Past their due date and not finished.">
        <DataList
          rows={overdueQueue}
          columns={TASK_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Overdue tasks"
          empty={<EmptyState icon={ListChecks}>Nothing is overdue. Work due this week is on the Tasks board.</EmptyState>}
        />
      </Section>

      <Section title="Recent activity" description="The last few things that happened across every client.">
        <DataList
          rows={activity}
          columns={ACTIVITY_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Recent activity"
          empty={<EmptyState icon={Link2}>Nothing has happened yet. Add a client to start the timeline.</EmptyState>}
        />
      </Section>
    </>
  );
}
