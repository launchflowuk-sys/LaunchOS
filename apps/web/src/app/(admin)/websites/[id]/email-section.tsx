import {
  siteEmailSummary,
  STORAGE_FULL_PCT,
  STORAGE_WARN_PCT,
  type SiteEmailOrder,
  type SiteEmailSummary,
  type SiteMailbox,
} from "@launchos/core";
import { createHostingerMailClientFromEnv } from "@launchos/integrations";
import { CalendarClock, Inbox, Mail, PoundSterling, Users } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { InlineAlert } from "@/components/inline-alert";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney, formatPence } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The Email section of a website page: every Hostinger mailbox on the site's
 * domains, how full each one is, and what the plan costs.
 *
 * A server component that fetches for itself, so the page wraps it in
 * `<Suspense>` and the rest of the page never waits on Hostinger. No client
 * code at all — nothing here is interactive.
 *
 * Bar fills are graphics, not text, so they need 3:1 against white rather than
 * 4.5:1; each sits beside a written figure, so colour is never the only signal.
 */
const FILL = {
  green: "bg-[oklch(0.6_0.16_150)]",
  orange: "bg-[oklch(0.66_0.17_50)]",
  red: "bg-[oklch(0.56_0.21_25)]",
} as const;

function storageFill(pct: number | null): string {
  if (pct === null || pct < STORAGE_WARN_PCT) return FILL.green;
  return pct < STORAGE_FULL_PCT ? FILL.orange : FILL.red;
}

/** Hostinger reports storage in KB (binary). */
function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${+(kb / (1024 * 1024)).toFixed(1)} GB`;
  if (kb >= 1024) return `${+(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

const PERIOD: Record<string, string> = { month: "month", year: "year", week: "week", day: "day" };

function periodLabel(n: number, unit: string): string {
  const word = PERIOD[unit] ?? unit;
  return n === 1 ? `a ${word}` : `every ${n} ${word}s`;
}

export async function SiteEmailSection({ organisationId, siteId }: { organisationId: string; siteId: string }) {
  const summary = await siteEmailSummary(getDb(), organisationId, siteId, {
    mail: createHostingerMailClientFromEnv(process.env),
  });
  return <EmailView summary={summary} />;
}

function EmailView({ summary }: { summary: SiteEmailSummary }) {
  if (!summary.ok) {
    return (
      <InlineAlert tone={summary.reason === "provider" ? "warning" : "info"} title={summary.reason === "not_configured" ? "Email not connected" : "Email could not be shown"}>
        {summary.message}
      </InlineAlert>
    );
  }
  if (summary.orders.length === 0) {
    return (
      <EmptyState icon={Mail}>
        No Hostinger email on {summary.domains.length > 0 ? summary.domains.join(", ") : "this website's domains"}.
      </EmptyState>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      <EmailKpis summary={summary} />
      {summary.missingRate.length > 0 ? (
        <InlineAlert tone="warning" title="No exchange rate stored">
          There is no {summary.missingRate.join(", ")} → GBP rate, so pound figures are blank rather than guessed.{" "}
          <Link href="/settings/costs" className="font-medium underline">Add one in Costs</Link>.
        </InlineAlert>
      ) : null}
      {summary.orders.map((order) => (
        <OrderPanel key={order.orderId} order={order} />
      ))}
    </div>
  );
}

function EmailKpis({ summary }: { summary: Extract<SiteEmailSummary, { ok: true }> }) {
  const { totals, orders } = summary;
  const trialThen = orders.filter((o) => o.isTrial).reduce((sum, o) => sum + (o.cost?.monthlyCostGbpMinor ?? 0), 0);
  const monthly = totals.monthlyCostGbpMinor;
  const perMailbox = monthly !== null && totals.mailboxes > 0 ? Math.round(monthly / totals.mailboxes) : null;
  const nextRenewal = orders
    .map((o) => o.renewsAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const unused = totals.seats - totals.mailboxes;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Mailboxes"
        value={`${totals.mailboxes}/${totals.seats}`}
        hint={unused > 0 ? `${unused} paid seat${unused === 1 ? "" : "s"} unused` : "Every paid seat in use"}
        category="delivery"
        icon={Users}
      />
      <StatCard
        label="Per month"
        value={monthly === null ? "Unknown" : formatPence(monthly)}
        hint={
          trialThen > 0
            ? monthly === 0
              ? `Free trial · then ${formatPence(trialThen)}/mo`
              : `Plus ${formatPence(trialThen)}/mo when the trial ends`
            : monthly === null
              ? "Cost not matched with certainty"
              : "What LaunchFlow pays Hostinger"
        }
        category="money"
        icon={PoundSterling}
      />
      <StatCard
        label="Per mailbox"
        value={perMailbox === null ? "—" : formatPence(perMailbox)}
        hint="Monthly, spread over mailboxes in use"
        category="money"
        icon={Inbox}
      />
      <StatCard
        label="Renews"
        value={nextRenewal ? formatDate(nextRenewal) : "—"}
        hint="Next Hostinger charge"
        category="overview"
        icon={CalendarClock}
      />
    </div>
  );
}

function PriceLine({ order }: { order: SiteEmailOrder }) {
  const cost = order.cost;
  if (!cost) {
    return (
      <div>
        <p className="text-[1.75rem] font-bold leading-tight text-muted-foreground">Cost unknown</p>
        <p className="mt-1 text-meta text-muted-foreground">No Hostinger subscription matches this order with certainty, so no price is guessed.</p>
      </div>
    );
  }
  const monthly = cost.monthlyCostGbpMinor !== null ? formatPence(cost.monthlyCostGbpMinor) : formatMoney(cost.monthlyCostMinor, cost.currency);
  const supplier = `${formatMoney(cost.renewalMinor, cost.currency)} ${periodLabel(cost.billingPeriod, cost.billingPeriodUnit)}`;
  return (
    <div>
      <p className="text-[1.75rem] font-bold leading-tight tabular-nums">
        {order.isTrial ? (
          <>
            £0 now <span className="text-[1.125rem] font-semibold text-muted-foreground">· then {monthly}/mo from {formatDate(order.renewsAt)}</span>
          </>
        ) : (
          <>
            {monthly}
            <span className="text-[1.125rem] font-semibold text-muted-foreground">/mo</span>
          </>
        )}
      </p>
      <p className="mt-1 text-meta text-muted-foreground">
        {supplier} · {cost.autoRenewed ? "auto-renews" : "does not auto-renew"} {formatDate(order.renewsAt)}
      </p>
    </div>
  );
}

function SeatsBar({ used, seats }: { used: number; seats: number }) {
  const usedPct = seats > 0 ? Math.min(100, Math.round((used / seats) * 100)) : 0;
  const unused = Math.max(0, seats - used);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="label-caps text-muted-foreground">Seats</span>
        <span className="text-meta tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{used} used</span> · {unused} paid, unused · {seats} total
        </span>
      </div>
      <div
        className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${used} of ${seats} seats in use`}
      >
        <div className={cn("h-full", FILL.green)} style={{ width: `${usedPct}%` }} />
        {unused > 0 ? <div className={cn("h-full", FILL.orange)} style={{ width: `${100 - usedPct}%` }} /> : null}
      </div>
    </div>
  );
}

function MailboxRow({ box }: { box: SiteMailbox }) {
  const pct = box.storagePct;
  return (
    <li className="grid min-w-0 gap-x-6 gap-y-2 py-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_8rem_5.5rem] md:items-center">
      <div className="min-w-0">
        <p className="text-[1.0625rem] font-semibold [overflow-wrap:anywhere]">
          {/* A break opportunity after the @, so a long address wraps at the domain rather than mid-word. */}
          {box.address.split("@")[0]}@<wbr />
          {box.address.split("@").slice(1).join("@")}
        </p>
        {box.status !== "active" ? <StatusBadge value={box.status} className="mt-1" /> : null}
      </div>
      <div className="min-w-0">
        <div
          className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`Storage for ${box.address}`}
          aria-valuenow={pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn("h-full rounded-full", storageFill(pct))} style={{ width: `${Math.max(pct ?? 0, 2)}%` }} />
        </div>
        <p className="mt-1 text-meta tabular-nums text-muted-foreground">
          {formatKb(box.storageUsedKb)} of {box.storageQuotaKb > 0 ? formatKb(box.storageQuotaKb) : "?"}
          {pct !== null ? <span className="font-semibold text-foreground"> · {pct}%</span> : null}
        </p>
      </div>
      <p className="text-meta tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground">{box.messagesUsed.toLocaleString("en-GB")}</span>
        {box.messagesQuota > 0 ? ` / ${box.messagesQuota.toLocaleString("en-GB")}` : ""} messages
      </p>
      <p className="text-meta tabular-nums text-muted-foreground md:text-right">
        {box.monthlyShareGbpMinor !== null ? (
          <>
            <span className="font-semibold text-foreground">{formatPence(box.monthlyShareGbpMinor)}</span>/mo
          </>
        ) : (
          "Share unknown"
        )}
      </p>
    </li>
  );
}

function OrderPanel({ order }: { order: SiteEmailOrder }) {
  return (
    <div className="min-w-0 rounded-[20px] border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all text-[1.375rem] font-semibold tracking-tight">{order.domain}</h3>
          <p className="text-sm text-muted-foreground">{order.planTitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {order.isTrial ? <StatusBadge value="trial" tone="info" label="free trial" /> : null}
          <StatusBadge value={order.status} />
        </div>
      </div>

      <div className="mt-5 grid min-w-0 gap-5 md:grid-cols-2 md:items-end">
        <PriceLine order={order} />
        <SeatsBar used={order.used} seats={order.seats} />
      </div>

      {order.mailboxes.length > 0 ? (
        <ul className="mt-5 divide-y border-t">
          {order.mailboxes.map((box) => (
            <MailboxRow key={box.address} box={box} />
          ))}
        </ul>
      ) : (
        <p className="mt-5 border-t pt-4 text-sm text-muted-foreground">No mailboxes created on this plan yet.</p>
      )}
    </div>
  );
}
