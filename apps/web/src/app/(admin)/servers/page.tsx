import { BUSINESS_LABELS, convert, COST_BUSINESSES, coolifyResourcesFor, listServers, ratesForCurrencies, settlePendingActions, type ServerView } from "@launchos/core";
import { Lock, Server as ServerIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { BusinessSelect } from "./business-select";
import { ExpandableRow } from "./expandable-row";
import { BUSY_LABEL } from "./labels";
import { RedeployButton, ServerActionsMenu } from "./server-actions-menu";
import { Sparkline } from "./sparkline";

export const dynamic = "force-dynamic";

const BUSINESS_OPTIONS = COST_BUSINESSES.map((value) => ({ value, label: BUSINESS_LABELS[value] }));

type CoolifyState = Awaited<ReturnType<typeof coolifyResourcesFor>> | null;

function statusOf(server: ServerView): { tone: StatusTone; label: string } {
  if (server.gone) {
    return { tone: "neutral", label: `Gone since ${formatDateTime(server.seenAt)}` };
  }
  if (server.pendingAction) {
    return { tone: "info", label: BUSY_LABEL[server.pendingAction.command] ?? "Busy" };
  }
  if (server.status === "running") return { tone: "success", label: "Running" };
  return { tone: "danger", label: server.status };
}

/** 0 healthy, 1 running but health unknown, 2 down or unhealthy — the row shows the worst. */
function resourceRank(state: string, health: string | null): 0 | 1 | 2 {
  if (state === "running" && (health === "healthy" || health === "unknown" || health === null)) {
    return health === "healthy" ? 0 : 1;
  }
  return 2;
}
const DOT = ["bg-success-solid", "bg-warning-solid", "bg-danger-solid"] as const;

/** Whether a server counts toward "Needs attention" — status, a stuck pending action, backups off, its account failing to sync, a dead Coolify, an unhealthy app, or traffic past 80%. */
function needsAttention(server: ServerView, coolify: CoolifyState): boolean {
  const trafficOver80 = server.includedTrafficBytes > 0 && server.outgoingTrafficBytes / server.includedTrafficBytes > 0.8;
  return (
    server.status !== "running" ||
    server.pendingAction !== null ||
    !server.backupsEnabled ||
    server.accountError !== null ||
    (coolify !== null && !coolify.ok) ||
    (coolify?.ok === true && coolify.resources.some((r) => r.state !== "running")) ||
    trafficOver80
  );
}

export default async function ServersPage() {
  const session = await requireAdmin();
  if (session.role !== "owner") {
    return (
      <>
        <PageHeader title="Servers" description="Every Hetzner server, its Coolify apps and what it costs." category="automation" />
        <EmptyState icon={ServerIcon} title="Owner only">
          Only the owner can see server infrastructure and costs.
        </EmptyState>
      </>
    );
  }

  const db = getDb();
  // A finished reboot should not read "Rebooting…" until the next 15-minute sync.
  await settlePendingActions(db, session.organisationId);
  const servers = await listServers(db, session.organisationId);
  const [coolifyResults, rates] = await Promise.all([
    Promise.all(servers.map((s): Promise<CoolifyState> => (s.coolify ? coolifyResourcesFor(db, session.organisationId, s.coolify.id) : Promise.resolve(null)))),
    ratesForCurrencies(db, session.organisationId, ["EUR"]),
  ]);
  const coolifyByServer = new Map(servers.map((s, i) => [s.id, coolifyResults[i] ?? null]));
  const eurToGbp = rates.EUR ?? null;

  // A missing rate is never treated as parity — the row falls back to €
  // only, with a page-level notice.
  const toGbpPence = (eurCents: number) => (eurToGbp === null ? null : convert(eurCents, "EUR", "GBP", eurToGbp));
  const kpiMoney = (eurCents: number) => {
    const p = toGbpPence(eurCents);
    return p === null ? formatMoney(eurCents, "EUR") : formatMoney(p, "GBP");
  };
  const rowMoney = (eurCents: number): ReactNode => {
    const p = toGbpPence(eurCents);
    return (
      <span className="flex flex-col whitespace-nowrap">
        {p === null ? <span className="text-muted-foreground">{formatMoney(eurCents, "EUR")}</span> : formatMoney(p, "GBP")}
        {p !== null ? <span className="text-meta text-muted-foreground">{formatMoney(eurCents, "EUR")}</span> : null}
      </span>
    );
  };

  // A server deleted in Hetzner stays listed as history but no longer bills or counts.
  const live = servers.filter((s) => !s.gone);
  const running = live.filter((s) => s.status === "running").length;
  const monthToDateTotal = live.reduce((sum, s) => sum + (s.cost?.monthToDate ?? 0), 0);
  const projectedTotal = live.reduce((sum, s) => sum + (s.cost?.projectedMonth ?? 0), 0);
  const attentionCount = live.filter((s) => needsAttention(s, coolifyByServer.get(s.id) ?? null)).length;

  const byAccount = new Map<string, ServerView[]>();
  for (const s of servers) byAccount.set(s.accountLabel, [...(byAccount.get(s.accountLabel) ?? []), s]);

  return (
    <>
      <PageHeader wide title="Servers" description="Every Hetzner server, its Coolify apps and what it costs." category="automation" />

      {eurToGbp === null ? (
        <p className="mb-6 rounded-[14px] border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-fg">
          No EUR→GBP rate is set — showing € only. Add one on{" "}
          <a href="/settings/costs" className="underline">
            Costs
          </a>
          .
        </p>
      ) : null}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Month to date" value={kpiMoney(monthToDateTotal)} category="automation" icon={ServerIcon} />
        <StatCard label="Projected month" value={kpiMoney(projectedTotal)} category="automation" icon={ServerIcon} />
        <StatCard label="Servers" value={`${running} / ${live.length}`} hint="running / total" category="automation" icon={ServerIcon} />
        <StatCard label="Needs attention" value={attentionCount} category="automation" icon={ServerIcon} attention={attentionCount > 0} />
      </div>

      {servers.length === 0 ? (
        <EmptyState icon={ServerIcon}>
          No servers yet. Connect a Hetzner account on{" "}
          <a href="/settings/infrastructure" className="underline">
            Infrastructure
          </a>
          .
        </EmptyState>
      ) : (
        [...byAccount.entries()].map(([account, rows]) => (
          <div key={account} className="mb-8 min-w-0 overflow-hidden rounded-[20px] border bg-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-5 py-3 text-sm font-semibold">
              {account}
              {rows[0]?.accountError ? (
                <span className="rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger-fg">{rows[0].accountError}</span>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              {/* Fits a 1280px screen beside the sidebar; scrolls, rather than squashes, below that. */}
              <div className="min-w-[930px]">
                <div className="label-caps flex items-center gap-2.5 border-b px-4 py-3 text-muted-foreground">
                  <span className="w-6 shrink-0" />
                  <span className="w-[150px] shrink-0">Server</span>
                  <span className="w-[110px] shrink-0">Status</span>
                  <span className="w-[144px] shrink-0">Business</span>
                  <span className="w-[88px] shrink-0">CPU 24h</span>
                  <span className="w-[56px] shrink-0">Traffic</span>
                  <span className="w-[80px] shrink-0 text-right">Month to date</span>
                  <span className="w-[80px] shrink-0 text-right">Projected</span>
                  <span className="min-w-0 flex-1">Apps</span>
                  <span className="w-8 shrink-0" />
                </div>
                {rows.map((server) => (
                  <ServerRow key={server.id} server={server} coolify={coolifyByServer.get(server.id) ?? null} money={rowMoney} />
                ))}
              </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function ServerRow({ server, coolify, money }: { server: ServerView; coolify: CoolifyState; money: (cents: number) => ReactNode }) {
  const status = statusOf(server);
  const cost = server.cost;
  const trafficPct = server.includedTrafficBytes > 0 ? Math.round((server.outgoingTrafficBytes / server.includedTrafficBytes) * 100) : 0;
  // The full month's base server price, not what has accrued so far: the
  // projected total less the variable components already tracked below.
  const monthlyBaseCents = cost ? cost.projectedMonth - cost.backups - cost.volumes - cost.primaryIps - cost.snapshots - cost.traffic : 0;

  const cells = (
    <>
      <span className="flex w-[150px] shrink-0 min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          {server.deleteProtected ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Delete protected" /> : null}
          <span className="truncate">{server.name}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1 text-meta text-muted-foreground">
          {server.serverType.toUpperCase()} · {server.location}
          {!server.backupsEnabled ? <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg">Backups off</span> : null}
        </span>
      </span>

      <span className="w-[110px] shrink-0">
        <StatusBadge value={status.label} tone={status.tone} label={status.label} />
      </span>

      <span className="w-[144px] shrink-0">
        <BusinessSelect serverId={server.id} business={server.business} options={BUSINESS_OPTIONS} />
      </span>

      <span className="w-[88px] shrink-0">
        <Sparkline values={server.metrics?.cpu} />
      </span>

      <span className="w-[56px] shrink-0">
        {server.includedTrafficBytes > 0 ? (
          <span className="flex flex-col gap-1">
            <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
              <span className={`block h-full ${trafficPct > 80 ? "bg-danger-solid" : "bg-primary"}`} style={{ width: `${Math.min(100, trafficPct)}%` }} />
            </span>
            <span className="text-meta text-muted-foreground">{trafficPct}%</span>
          </span>
        ) : (
          <span className="text-meta text-muted-foreground">—</span>
        )}
      </span>

      <span className="w-[80px] shrink-0 text-right tabular-nums">{cost ? money(cost.monthToDate) : "—"}</span>
      <span className="w-[80px] shrink-0 text-right tabular-nums">{cost ? money(cost.projectedMonth) : "—"}</span>

      <span className="min-w-0 flex-1 text-meta">
        <AppsSummary coolify={coolify} />
      </span>

      <span className="flex w-8 shrink-0 justify-end">
        <ServerActionsMenu
          serverId={server.id}
          serverName={server.name}
          status={server.status}
          backupsEnabled={server.backupsEnabled}
          monthlyBaseCents={monthlyBaseCents}
          pendingCommand={server.pendingAction?.command}
        />
      </span>
    </>
  );

  return (
    <ExpandableRow name={server.name} cells={cells}>
      <div className="grid gap-x-10 gap-y-5 border-t py-4 pl-9 text-sm lg:grid-cols-2">
        {cost ? (
          <div className="grid grid-cols-3 content-start gap-x-8 gap-y-3">
            <CostLine label="Base" value={money(cost.base)} />
            <CostLine label="Backups" value={money(cost.backups)} />
            <CostLine label="Volumes" value={money(cost.volumes)} />
            <CostLine label="IPv4" value={money(cost.primaryIps)} />
            <CostLine label="Snapshots" value={money(cost.snapshots)} />
            <CostLine label="Traffic" value={money(cost.traffic)} />
          </div>
        ) : (
          <p className="text-meta text-muted-foreground">No cost yet.</p>
        )}
        <AppsList server={server} coolify={coolify} />
      </div>
    </ExpandableRow>
  );
}

/** The row's one-cell view of Coolify: how many apps, and the worst state among them. */
function AppsSummary({ coolify }: { coolify: CoolifyState }) {
  if (!coolify) return <span className="text-muted-foreground">No Coolify</span>;
  if (!coolify.ok) return <span className="text-danger-fg" title={coolify.message}>unreachable</span>;
  if (coolify.resources.length === 0) return <span className="text-muted-foreground">No apps</span>;
  const worst = Math.max(...coolify.resources.map((r) => resourceRank(r.state, r.health))) as 0 | 1 | 2;
  const n = coolify.resources.length;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={`size-1.5 shrink-0 rounded-full ${DOT[worst]}`} aria-hidden />
      {n} {n === 1 ? "app" : "apps"}
    </span>
  );
}

/** Every Coolify app on the server, each with its own Redeploy. Lives in the expanded row. */
function AppsList({ server, coolify }: { server: ServerView; coolify: CoolifyState }) {
  if (!coolify || !server.coolify) return <p className="text-meta text-muted-foreground">No Coolify linked to this server.</p>;
  if (!coolify.ok) return <p className="text-meta text-danger-fg">Coolify unreachable — {coolify.message}</p>;
  if (coolify.resources.length === 0) return <p className="text-meta text-muted-foreground">No apps on this Coolify.</p>;
  const link = server.coolify;
  return (
    <ul className="flex flex-col gap-1">
      {coolify.resources.map((resource) => (
        <li key={resource.uuid} className="flex items-center gap-2 text-meta">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT[resourceRank(resource.state, resource.health)]}`} aria-hidden />
          <a href={link.baseUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate underline underline-offset-2">
            {resource.name}
          </a>
          {resource.kind === "application" ? <RedeployButton connectionId={link.id} appUuid={resource.uuid} appName={resource.name} /> : null}
        </li>
      ))}
    </ul>
  );
}

function CostLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
