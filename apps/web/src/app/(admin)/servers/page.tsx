import { BUSINESS_LABELS, convert, COST_BUSINESSES, coolifyResourcesFor, listServers, ratesForCurrencies, type ServerView } from "@launchos/core";
import { Lock, Server as ServerIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { BusinessSelect } from "./business-select";
import { BUSY_LABEL } from "./labels";
import { RedeployButton, ServerActionsMenu } from "./server-actions-menu";
import { Sparkline } from "./sparkline";

export const dynamic = "force-dynamic";

const HOUR_MS = 60 * 60 * 1000;

const BUSINESS_OPTIONS = COST_BUSINESSES.map((value) => ({ value, label: BUSINESS_LABELS[value] }));

type CoolifyState = Awaited<ReturnType<typeof coolifyResourcesFor>> | null;

function statusOf(server: ServerView): { tone: StatusTone; label: string } {
  if (Date.now() - server.seenAt.getTime() > HOUR_MS) {
    return { tone: "neutral", label: `Not seen since ${formatDateTime(server.seenAt)}` };
  }
  if (server.pendingAction) {
    return { tone: "info", label: BUSY_LABEL[server.pendingAction.command] ?? "Busy" };
  }
  if (server.status === "running") return { tone: "success", label: "Running" };
  return { tone: "danger", label: server.status };
}

function resourceDot(state: string, health: string | null): string {
  if (state === "running" && (health === "healthy" || health === "unknown" || health === null)) {
    return health === "healthy" ? "bg-success-solid" : "bg-warning-solid";
  }
  return "bg-danger-solid";
}

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
      <span className="whitespace-nowrap">
        {p === null ? <span className="text-muted-foreground">{formatMoney(eurCents, "EUR")}</span> : formatMoney(p, "GBP")}
        {p !== null ? <span className="ml-1 text-meta text-muted-foreground">{formatMoney(eurCents, "EUR")}</span> : null}
      </span>
    );
  };

  const running = servers.filter((s) => s.status === "running").length;
  const monthToDateTotal = servers.reduce((sum, s) => sum + (s.cost?.monthToDate ?? 0), 0);
  const projectedTotal = servers.reduce((sum, s) => sum + (s.cost?.projectedMonth ?? 0), 0);
  const attentionCount = servers.filter((s) => needsAttention(s, coolifyByServer.get(s.id) ?? null)).length;

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
        <StatCard label="Servers" value={`${running} / ${servers.length}`} hint="running / total" category="automation" icon={ServerIcon} />
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
              <div className="min-w-[1180px]">
                <div className="label-caps flex items-center gap-4 border-b px-5 py-3 text-muted-foreground">
                  <span className="w-[240px] shrink-0">Server</span>
                  <span className="w-[150px] shrink-0">Status</span>
                  <span className="w-[160px] shrink-0">Business</span>
                  <span className="w-[130px] shrink-0">CPU 24h</span>
                  <span className="w-[130px] shrink-0">Traffic</span>
                  <span className="w-[100px] shrink-0 text-right">Month to date</span>
                  <span className="w-[100px] shrink-0 text-right">Projected</span>
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

  return (
    <details className="group border-b px-5 last:border-0 open:bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-4 py-4 [&::-webkit-details-marker]:hidden">
        <span className="flex w-[240px] shrink-0 min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 truncate font-medium">
            {server.deleteProtected ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Delete protected" /> : null}
            {server.name}
          </span>
          <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
            {server.serverType.toUpperCase()} · {server.location}
            {!server.backupsEnabled ? <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg">Backups off</span> : null}
          </span>
        </span>

        <span className="w-[150px] shrink-0">
          <StatusBadge value={status.label} tone={status.tone} label={status.label} />
        </span>

        <span className="w-[160px] shrink-0">
          <BusinessSelect serverId={server.id} business={server.business} options={BUSINESS_OPTIONS} />
        </span>

        <span className="w-[130px] shrink-0">
          <Sparkline values={server.metrics?.cpu} />
        </span>

        <span className="w-[130px] shrink-0">
          {server.includedTrafficBytes > 0 ? (
            <span className="flex flex-col gap-1">
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                <span
                  className={`block h-full ${trafficPct > 80 ? "bg-danger-solid" : "bg-primary"}`}
                  style={{ width: `${Math.min(100, trafficPct)}%` }}
                />
              </span>
              <span className="text-meta text-muted-foreground">{trafficPct}%</span>
            </span>
          ) : (
            <span className="text-meta text-muted-foreground">—</span>
          )}
        </span>

        <span className="w-[100px] shrink-0 text-right tabular-nums">{cost ? money(cost.monthToDate) : "—"}</span>
        <span className="w-[100px] shrink-0 text-right tabular-nums">{cost ? money(cost.projectedMonth) : "—"}</span>

        <span className="min-w-0 flex-1">
          {!coolify ? (
            <span className="text-meta text-muted-foreground">No Coolify</span>
          ) : !coolify.ok ? (
            <span className="text-meta text-danger-fg">unreachable — {coolify.message}</span>
          ) : coolify.resources.length === 0 ? (
            <span className="text-meta text-muted-foreground">No apps</span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {coolify.resources.map((resource) => (
                <span key={resource.uuid} className="flex items-center gap-1.5 text-meta">
                  <span className={`size-1.5 shrink-0 rounded-full ${resourceDot(resource.state, resource.health)}`} aria-hidden />
                  {server.coolify ? (
                    <a href={server.coolify.baseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                      {resource.name}
                    </a>
                  ) : (
                    resource.name
                  )}
                  {resource.kind === "application" && server.coolify ? (
                    <RedeployButton connectionId={server.coolify.id} appUuid={resource.uuid} appName={resource.name} />
                  ) : null}
                </span>
              ))}
            </span>
          )}
        </span>

        <span className="w-8 shrink-0">
          <ServerActionsMenu
            serverId={server.id}
            serverName={server.name}
            status={server.status}
            backupsEnabled={server.backupsEnabled}
            monthlyBaseCents={monthlyBaseCents}
            pendingCommand={server.pendingAction?.command}
          />
        </span>
      </summary>

      {cost ? (
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 border-t py-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <CostLine label="Base" value={money(cost.base)} />
          <CostLine label="Backups" value={money(cost.backups)} />
          <CostLine label="Volumes" value={money(cost.volumes)} />
          <CostLine label="IPv4" value={money(cost.primaryIps)} />
          <CostLine label="Snapshots" value={money(cost.snapshots)} />
          <CostLine label="Traffic" value={money(cost.traffic)} />
        </div>
      ) : null}
    </details>
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
