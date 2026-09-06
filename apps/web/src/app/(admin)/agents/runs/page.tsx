import { agentRunHealth, listAgentKeys, listAgentRuns, type AgentRunSummary } from "@launchos/core";
import { Bot } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Pager, PAGE_SIZE, pageParam } from "@/components/pager";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { RunFilterBar } from "./run-filters";

export const dynamic = "force-dynamic";

/** Seven days: long enough to cover a weekend, short enough that "two failed" still means something. */
const HEALTH_WINDOW_DAYS = 7;

/** Only what the enums accept reaches core; anything else is treated as no filter at all. */
function one(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}
function oneOf<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  const raw = one(value);
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** "1m 04s", or "—" while it is still going. */
function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const COLUMNS: readonly DataListColumn<AgentRunSummary>[] = [
  {
    key: "agent",
    header: "Agent",
    primary: true,
    cell: (run) => (
      <Link href={`/agents/runs/${run.id}`} className="hover:underline">
        {run.agentKey}
      </Link>
    ),
  },
  { key: "trigger", header: "Trigger", cell: (run) => run.trigger },
  { key: "started", header: "Started", cell: (run) => <span className="whitespace-nowrap">{formatDateTime(run.startedAt)}</span> },
  { key: "took", header: "Took", numeric: true, cell: (run) => duration(run.durationMs) },
  { key: "steps", header: "Steps", numeric: true, hideOnMobile: true, cell: (run) => run.steps },
  {
    key: "tokens",
    header: "Tokens",
    numeric: true,
    hideOnMobile: true,
    cell: (run) => (run.tokensIn + run.tokensOut > 0 ? (run.tokensIn + run.tokensOut).toLocaleString("en-GB") : "—"),
  },
  {
    key: "outcome",
    header: "Outcome",
    className: "text-left",
    cell: (run) =>
      run.error ? (
        <span className="text-danger-fg">{run.error.length > 140 ? `${run.error.slice(0, 140)}…` : run.error}</span>
      ) : run.summary ? (
        <span className="text-muted-foreground">{run.summary.length > 140 ? `${run.summary.slice(0, 140)}…` : run.summary}</span>
      ) : (
        "—"
      ),
  },
  { key: "status", header: "Status", status: true, cell: (run) => <StatusBadge value={run.status} /> },
];

/**
 * Every agent run, newest first.
 *
 * The kernel has recorded all of this since the beginning, and until now the
 * only door into it was a link from something a run produced — an ad report, a
 * brief, an incident. That is precisely backwards: a run that produced nothing
 * is the one worth finding, and `/agents/runs` used to be a 404.
 */
export default async function AgentRunsPage({ searchParams }: PageProps<"/agents/runs">) {
  const session = await requireAdmin();
  const params = await searchParams;

  const agent = one(params.agent);
  const status = oneOf(params.status, ["running", "completed", "awaiting_approval", "failed"] as const);
  const trigger = oneOf(params.trigger, ["cron", "event", "manual", "resume"] as const);
  const page = pageParam(params.page);
  const now = new Date();
  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [{ runs, total }, agents, health] = await Promise.all([
    listAgentRuns(getDb(), session.organisationId, {
      ...(agent ? { agentKey: agent } : {}),
      ...(status ? { status } : {}),
      ...(trigger ? { trigger } : {}),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    listAgentKeys(getDb(), session.organisationId),
    agentRunHealth(getDb(), session.organisationId, since),
  ]);

  const filtered = agent !== undefined || status !== undefined || trigger !== undefined;

  return (
    <>
      <PageHeader
        title="Agent runs"
        description={`Every run the kernel recorded, newest first. ${total.toLocaleString("en-GB")} ${filtered ? "matching" : "in total"}.`}
        category="automation"
      />

      <Section title={`Last ${HEALTH_WINDOW_DAYS} days`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Completed" value={health.completed} category="automation" />
          <StatCard label="Running" value={health.running} category="automation" />
          <StatCard
            label="Waiting on a decision"
            value={health.awaiting_approval}
            hint="Parked until somebody approves"
            href="/approvals"
            category="automation"
          />
          <StatCard
            label="Failed"
            value={health.failed}
            hint="Stopped with an error"
            href="/agents/runs?status=failed"
            category="automation"
            attention
          />
        </div>
      </Section>

      <Section>
        <RunFilterBar agents={agents} current={{ agent, status, trigger }} />
        <div className="mt-4">
          <DataList
            rows={runs}
            columns={COLUMNS}
            getRowKey={(run) => run.id}
            caption="Agent runs"
            empty={
              <EmptyState icon={Bot} title={filtered ? "No runs match those filters" : "No agent has run yet"}>
                {filtered
                  ? "Widen the filters, or clear them to see everything the kernel has recorded."
                  : "Runs appear here as soon as an agent starts — from a cron, an event, or a Run now button."}
              </EmptyState>
            }
          />
          <Pager
            basePath="/agents/runs"
            query={{ agent, status, trigger }}
            page={page}
            hasNext={page * PAGE_SIZE < total}
          />
        </div>
      </Section>
    </>
  );
}
