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
import { agentCatalog } from "@/lib/agent-catalog";
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

/**
 * What started it, in words rather than the enum.
 *
 * `cron`, `event`, `manual`, `resume` are what the column holds and what the
 * filter sends; they are not what somebody scanning a page of runs needs to
 * read. The distinction that matters is whether a person asked for this.
 */
const TRIGGER_LABEL: Record<string, string> = {
  cron: "Scheduled",
  event: "Triggered",
  manual: "By hand",
  resume: "Resumed",
};

/** "4m ago", "3h ago", "2d ago" — the form the eye wants on a list of runs. */
function ago(then: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One line, never a wall. A stack trace in a table cell is what made this look like a log file. */
function trim(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The ledger reads as a sentence per run: which agent, what came of it, who
 * asked and when.
 *
 * It used to lead with the raw `agent_key` and put the one column carrying
 * meaning — what the run actually did — between two columns of numbers. The
 * numbers are still here because they are how a runaway agent is spotted, but
 * they are secondary and are styled as such.
 */
function columnsFor(agentNames: Map<string, string>, now: Date): readonly DataListColumn<AgentRunSummary>[] {
  return [
    {
      key: "agent",
      header: "Agent",
      primary: true,
      cell: (run) => (
        <Link href={`/agents/runs/${run.id}`} className="block min-w-0 hover:underline">
          <span className="font-medium">{agentNames.get(run.agentKey) ?? run.agentKey}</span>
          <span className="mt-0.5 block text-meta text-muted-foreground">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
        </Link>
      ),
    },
    {
      key: "outcome",
      header: "What happened",
      className: "text-left",
      cell: (run) =>
        run.error ? (
          <span className="text-danger-fg">{trim(run.error)}</span>
        ) : run.summary ? (
          <span>{trim(run.summary)}</span>
        ) : (
          <span className="text-muted-foreground">No summary recorded</span>
        ),
    },
    {
      key: "started",
      header: "Started",
      cell: (run) => (
        <span className="whitespace-nowrap" title={formatDateTime(run.startedAt)}>
          {ago(run.startedAt, now)}
        </span>
      ),
    },
    { key: "took", header: "Took", numeric: true, cell: (run) => duration(run.durationMs) },
    {
      key: "work",
      header: "Steps · tokens",
      numeric: true,
      hideOnMobile: true,
      className: "text-meta text-muted-foreground",
      cell: (run) => {
        const tokens = run.tokensIn + run.tokensOut;
        return `${run.steps} · ${tokens > 0 ? tokens.toLocaleString("en-GB") : "—"}`;
      },
    },
    { key: "status", header: "Status", status: true, cell: (run) => <StatusBadge value={run.status} /> },
  ];
}

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
  const status = oneOf(params.status, ["running", "completed", "awaiting_approval", "failed", "skipped"] as const);
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
  // Read off the definitions, so a renamed agent renames itself here too.
  const agentNames = new Map(agentCatalog().map((entry) => [entry.key, entry.name]));

  return (
    <>
      <PageHeader
        wide
        title="Agent runs"
        description={`Every run the kernel recorded, newest first. ${total.toLocaleString("en-GB")} ${filtered ? "matching" : "in total"}.`}
        category="automation"
      />

      <Section title={`Last ${HEALTH_WINDOW_DAYS} days`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
          <StatCard
            label="Skipped"
            value={health.skipped}
            hint="Queued, but the agent is not switched on"
            href="/agents/runs?status=skipped"
            category="automation"
          />
        </div>
      </Section>

      <Section>
        <RunFilterBar agents={agents} current={{ agent, status, trigger }} />
        <div className="mt-4">
          <DataList
            rows={runs}
            columns={columnsFor(agentNames, now)}
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
