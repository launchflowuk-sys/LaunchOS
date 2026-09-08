import { deliveryPipeline, latestOpsBrief, listActivity, listTasks, nextMeeting, revenueByMonth } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray } from "drizzle-orm";
import {
  Activity,
  AlarmClock,
  CalendarClock,
  Link2,
  ListChecks,
  Globe,
  LineChart,
  MessageSquare,
  Rocket,
  ShieldCheck,
  Siren,
  Sunrise,
  Users,
  Video,
  Wallet,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StageBar } from "@/components/progress-bar";
import { StatusBadge } from "@/components/status-badge";
import { RevenueChart } from "@/components/revenue-chart";
import { StatCard, type StatCardProps } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { formatInZone } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatPence } from "@/lib/format";
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
/** Enough pipeline to see the shape of the month without becoming the Projects page. */
const PIPELINE_LIMIT = 6;
const REVENUE_MONTHS = 6;

type ApprovalRow = { id: string; title: string; kind: string; createdAt: Date };
type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];
type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];

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
    upcomingMeeting,
    activeClients,
    liveSites,
    pipeline,
    revenue,
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
    nextMeeting(db, org, now),
    db
      .select({ value: count() })
      .from(schema.clients)
      .where(and(eq(schema.clients.organisationId, org), eq(schema.clients.status, "active"))),
    db
      .select({ value: count() })
      .from(schema.sites)
      .where(and(eq(schema.sites.organisationId, org), eq(schema.sites.status, "live"))),
    deliveryPipeline(db, org, PIPELINE_LIMIT),
    revenueByMonth(db, org, REVENUE_MONTHS, now),
  ]);

  // The revenue headline is the month we are in; the trend compares it with the
  // month before. Both come from the same series the chart draws, so the number
  // and the bars can never disagree.
  const thisMonth = revenue[revenue.length - 1]?.pence ?? 0;
  const lastMonth = revenue[revenue.length - 2]?.pence ?? 0;
  const revenueTrend = lastMonth === 0
    ? undefined
    : {
        value: `${thisMonth >= lastMonth ? "+" : ""}${Math.round(((thisMonth - lastMonth) / lastMonth) * 100)}%`,
        direction: thisMonth >= lastMonth ? ("up" as const) : ("down" as const),
        caption: "vs last month",
      };
  const dueThisMonth = pipeline.filter((row) => row.targetDate?.slice(0, 7) === now.toISOString().slice(0, 7)).length;

  // Attention-first: the three counts that mean a person has to do something
  // lead, and they take the semantic tint the moment they are above zero. The
  // three behind them are context and keep their category hue.
  // Four headline figures, not seven tiles. The UI brief is explicit: a row of
  // small pale cards is unreadable, so the primaries are the four numbers that
  // describe the business and everything that *needs* a person moves into the
  // panel below, where it can carry a name and a date rather than only a count.
  const cards: readonly StatCardProps[] = [
    {
      label: "Active clients",
      value: activeClients[0]?.value ?? 0,
      href: "/clients",
      hint: `${onboarding[0]?.value ?? 0} still onboarding`,
      category: "overview",
      icon: Users,
    },
    {
      label: "Revenue this month",
      value: formatPence(thisMonth),
      href: "/invoices",
      hint: "Collected, paid invoices only",
      category: "money",
      icon: Wallet,
      ...(revenueTrend ? { trend: revenueTrend } : {}),
      spark: revenue.map((r) => r.pence),
    },
    {
      label: "Projects in delivery",
      value: pipeline.length,
      href: "/projects",
      hint: dueThisMonth > 0 ? `${dueThisMonth} due this month` : "None due this month",
      category: "delivery",
      icon: Workflow,
    },
    {
      label: "Websites online",
      value: liveSites[0]?.value ?? 0,
      href: "/websites",
      hint: openIncidents[0]?.value ? `${openIncidents[0].value} with an open incident` : "All healthy",
      category: "support",
      icon: Globe,
    },
  ];

  // The counts that mean somebody has to do something. Smaller, below the
  // headline row, and still wearing the semantic tint the moment they are
  // above zero — "needs you" must never be mistaken for "fine".
  const attention: readonly StatCardProps[] = [
    {
      label: "Pending approvals",
      value: pendingApprovals[0]?.value ?? 0,
      href: "/approvals",
      hint: "Waiting on a human decision",
      category: "automation",
      icon: ShieldCheck,
      attention: true,
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
    },
    {
      label: "Overdue tasks",
      value: overdueTasks[0]?.value ?? 0,
      href: "/tasks",
      hint: "Past their due date",
      category: "delivery",
      icon: AlarmClock,
      attention: true,
    },
    {
      label: "Open cases",
      value: openTickets[0]?.value ?? 0,
      href: "/cases",
      hint: `${dueThisWeek[0]?.value ?? 0} tasks due this week`,
      category: "support",
      icon: MessageSquare,
    },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="What needs attention right now." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      {/* Delivery and money, side by side — the two questions asked most often
          about an agency, answered without a click. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          title="Delivery pipeline"
          description="Active projects from brief to launch."
          icon={Workflow}
          category="delivery"
          action={{ label: "View all", href: "/projects" }}
        >
          {pipeline.length === 0 ? (
            <EmptyState icon={Workflow}>
              Nothing in delivery. Projects appear here once a proposal is accepted.
            </EmptyState>
          ) : (
            <ul className="min-w-0 divide-y">
              {pipeline.map((row) => (
                // One line that holds together: the name truncates, the bar
                // takes what is left, and the date drops out below `lg` rather
                // than wrapping the row into two and breaking the rhythm of the
                // list.
                <li key={row.projectId} className="flex min-w-0 items-center gap-3 py-4 first:pt-0 last:pb-0 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <Link href={`/projects/${row.projectId}`} className="block truncate text-sm font-semibold hover:underline">
                      {row.name}
                    </Link>
                    <p className="truncate text-meta text-muted-foreground">{row.clientName}</p>
                  </div>
                  {row.stage ? <StatusBadge value={row.stage} className="hidden shrink-0 sm:inline-flex" /> : null}
                  <StageBar value={row.progress} className="w-20 shrink-0 sm:w-28 lg:w-40" />
                  <span className="hidden w-24 shrink-0 text-right text-meta whitespace-nowrap text-muted-foreground lg:block">
                    {row.targetDate ? formatDate(new Date(`${row.targetDate}T00:00:00Z`)) : "No date"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Revenue pulse"
          description="Collected in the last six months."
          icon={LineChart}
          category="money"
          figure={formatPence(thisMonth)}
        >
          <RevenueChart data={revenue} />
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {attention.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      <div className="mt-4">
        <StatCard
          label="Next meeting"
          value={upcomingMeeting ? formatInZone(upcomingMeeting.startsAt, "Europe/London", "short").replace(/ [A-Z]+$/, "") : "None"}
          href={upcomingMeeting ? `/meetings/${upcomingMeeting.id}` : "/meetings"}
          hint={upcomingMeeting ? `With ${upcomingMeeting.guestName}` : "Nothing booked"}
          category="organisation"
          icon={Video}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Waiting on a decision"
          description="Nothing here reaches a client, moves money or changes DNS until you release it."
          icon={ShieldCheck}
          category="automation"
          action={{ label: "Approvals", href: "/approvals" }}
        >
          {approvalQueue.length === 0 ? (
            <EmptyState icon={ShieldCheck}>
              Nothing is waiting for a decision. Agents park outward actions here before they happen.
            </EmptyState>
          ) : (
            <ul className="min-w-0 divide-y">
              {approvalQueue.map((row) => (
                // Stacks on a phone and sits on one line from `sm` up. The old
                // table did the opposite: it squeezed five columns into 360px
                // and made every one of them unreadable.
                <li key={row.id} className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{row.title}</p>
                    <p className="mt-0.5 text-meta text-muted-foreground">
                      {row.kind.replaceAll("_", " ")} · {formatDateTime(row.createdAt)}
                    </p>
                  </div>
                  <Button asChild variant="secondary" size="sm" className="shrink-0 self-start sm:self-auto">
                    <Link href="/approvals">Decide</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Overdue tasks"
          description="Past their due date and not finished."
          icon={AlarmClock}
          category="delivery"
          action={{ label: "All tasks", href: "/tasks" }}
        >
          {overdueQueue.length === 0 ? (
            <EmptyState icon={ListChecks}>Nothing is overdue. Work due this week is on the Tasks board.</EmptyState>
          ) : (
            <ul className="min-w-0 divide-y">
              {overdueQueue.map((row) => (
                <li key={row.id} className="flex min-w-0 items-center gap-3 py-4 first:pt-0 last:pb-0 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <Link href={`/tasks/${row.id}`} className="block truncate text-sm font-semibold hover:underline">
                      {row.title}
                    </Link>
                    <p className="mt-0.5 truncate text-meta text-muted-foreground">
                      {row.clientName} · {row.assigneeName ?? "Unassigned"}
                    </p>
                  </div>
                  <span className="shrink-0 text-meta font-semibold whitespace-nowrap text-danger-fg">
                    {formatDate(row.dueAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel
          title="This morning's brief"
          description="What the Ops Brief agent saw at 07:00, and what it says needs you."
          icon={Sunrise}
          category="automation"
          action={{ label: "All briefs", href: "/briefs" }}
        >
          <BriefCard brief={brief} />
        </Panel>

        <Panel
          title="Recent activity"
          description="The last few things that happened across every client."
          icon={Activity}
          action={{ label: "Everything", href: "/activity" }}
        >
          {activity.length === 0 ? (
            <EmptyState icon={Link2}>Nothing has happened yet. Add a client to start the timeline.</EmptyState>
          ) : (
            <ul className="min-w-0 divide-y">
              {activity.map((row) => (
                <li key={row.id} className="flex min-w-0 items-baseline gap-3 py-3.5 first:pt-0 last:pb-0 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    {isInAppPath(row.link) ? (
                      <Link href={row.link} className="text-sm hover:underline">
                        {row.title}
                      </Link>
                    ) : (
                      <span className="text-sm">{row.title}</span>
                    )}
                    <p className="mt-0.5 text-meta text-muted-foreground">{row.kind.replaceAll("_", " ")}</p>
                  </div>
                  <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground">
                    {formatDateTime(row.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

    </>
  );
}
