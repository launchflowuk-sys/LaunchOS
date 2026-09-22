import type { ClientDashboard, DashboardTrend } from "@launchos/core";
import {
  ArrowDownRight, ArrowUpRight, CheckCircle2, Clock, CreditCard, Globe, Link2, ListChecks,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { formatDate, formatPence } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The panels of the client's dashboard.
 *
 * Every figure here comes from `clientDashboard`, which reads them all against
 * one `now`. Nothing in this file computes a number; if it is on screen, the
 * database said so.
 *
 * The tiles are deliberately quieter than the admin's KPI cards. A client
 * opens this a few times a year and needs to know whether anything is wrong
 * before they can read a word — so the colour is spent on state (a green dot,
 * an amber count) and the surfaces stay white.
 */

/* -------------------------------------------------------------------------- */
/* Status tiles                                                               */
/* -------------------------------------------------------------------------- */

function Dot({ tone }: { tone: "good" | "warn" | "bad" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "good" && "bg-success-fg",
        tone === "warn" && "bg-warning-fg",
        tone === "bad" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground/40",
      )}
    />
  );
}

interface TileProps {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "idle";
  hint?: React.ReactNode;
  href?: string;
}

/**
 * One fact, at a glance. `href` makes the whole tile the link rather than a
 * word inside it — the tile is the target a thumb aims at.
 */
function Tile({ icon: Icon, label, value, tone, hint, href }: TileProps) {
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
        <Icon aria-hidden strokeWidth={1.75} className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="label-caps block text-muted-foreground">{label}</span>
        <span className="mt-0.5 flex items-center gap-2">
          {tone ? <Dot tone={tone} /> : null}
          <span className="truncate text-lg font-semibold tracking-[-0.01em]">{value}</span>
        </span>
        {hint ? <span className="mt-1 block text-meta text-muted-foreground">{hint}</span> : null}
      </span>
    </>
  );

  const shell = "flex items-start gap-3 rounded-2xl border bg-card p-4 transition-colors";
  return href ? (
    <Link href={href} className={cn(shell, "hover:border-primary/40 hover:bg-primary-soft/30")}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/** The change against the previous 30 days, when there is one worth showing. */
function Trend({ trend, suffix }: { trend: DashboardTrend | null; suffix?: string }) {
  if (!trend) return null;
  const Icon = trend.changePercent > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", trend.good ? "text-success-fg" : "text-warning-fg")}>
      <Icon aria-hidden className="size-3.5" />
      {Math.abs(trend.changePercent)}%{suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export function DashboardTiles({ data }: { data: ClientDashboard }) {
  const { site, uptime, domain, plan, work } = data;
  const openWork = work.inProgress + work.waitingOnClient;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        icon={Globe}
        label="Website"
        value={site === null ? "Not set up yet" : uptime.up === null ? "Not monitored" : uptime.up ? "Online" : "Offline"}
        tone={site === null ? "idle" : uptime.up === null ? "idle" : uptime.up ? "good" : "bad"}
        hint={
          uptime.percent === null
            ? site === null
              ? "We will add yours here"
              : "Monitoring starts shortly"
            : `${uptime.percent}% uptime over 30 days`
        }
        {...(site ? { href: "/portal/sites" } : {})}
      />

      <Tile
        icon={Link2}
        label="Domain"
        value={domain?.name ?? "None yet"}
        tone={domain ? "good" : "idle"}
        hint={domain?.expiresAt ? `Renews ${formatDate(domain.expiresAt)}` : undefined}
        {...(domain ? { href: "/portal/domains" } : {})}
      />

      <Tile
        icon={CreditCard}
        label="Your plan"
        value={plan ? `${formatPence(plan.amountPence, plan.currency)}/month` : "No plan"}
        tone={plan?.status === "active" ? "good" : plan ? "warn" : "idle"}
        hint={
          plan?.status === "cancelled"
            ? plan.renewsAt ? `Ends ${formatDate(plan.renewsAt)}` : "Cancelled"
            : plan?.renewsAt ? `Renews ${formatDate(plan.renewsAt)}` : undefined
        }
        href="/portal/plan"
      />

      <Tile
        icon={ListChecks}
        label="Open work"
        value={openWork === 0 ? "All clear" : `${openWork} ${openWork === 1 ? "item" : "items"}`}
        tone={work.waitingOnClient > 0 ? "warn" : openWork > 0 ? "good" : "idle"}
        hint={
          openWork === 0
            ? work.doneThisWindow > 0 ? `${work.doneThisWindow} finished this month` : "Nothing scheduled"
            : [
                work.inProgress > 0 ? `${work.inProgress} in progress` : null,
                work.waitingOnClient > 0 ? `${work.waitingOnClient} waiting on you` : null,
              ].filter(Boolean).join(" · ")
        }
        href="/portal/tasks"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Website health                                                             */
/* -------------------------------------------------------------------------- */

function HealthRow({ label, value, tone }: { label: string; value: string; tone?: "good" | "idle" | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 last:border-b-0">
      <span className="text-row text-muted-foreground">{label}</span>
      <span className={cn("flex items-center gap-1.5 text-row font-medium", tone === "good" && "text-success-fg")}>
        {tone === "good" ? <CheckCircle2 aria-hidden className="size-4" /> : null}
        {value}
      </span>
    </div>
  );
}

/** Minutes, hours or days — whichever makes "last checked" read like a person said it. */
function ago(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function WebsiteHealth({ data, now }: { data: ClientDashboard; now: Date }) {
  const { site, uptime, incidents } = data;
  if (!site) return null;

  const healthy = uptime.up !== false;

  return (
    <div className="rounded-2xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-figure font-semibold tracking-[-0.01em]">{site.name}</h2>
          <a
            href={site.primaryUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-row text-primary hover:underline"
          >
            {site.primaryUrl.replace(/^https?:\/\//, "")}
          </a>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-meta font-medium",
            healthy ? "bg-success-bg text-success-fg" : "bg-destructive/10 text-destructive",
          )}
        >
          <Dot tone={healthy ? "good" : "bad"} />
          {healthy ? "Live & healthy" : "We are on it"}
        </span>
      </div>

      <div className="mt-4">
        <HealthRow
          label="Uptime, last 30 days"
          value={uptime.percent === null ? "Not measured yet" : `${uptime.percent}%`}
          tone={uptime.percent !== null && uptime.percent >= 99 ? "good" : undefined}
        />
        <HealthRow
          label="Average response"
          value={uptime.responseMs === null ? "—" : `${uptime.responseMs} ms`}
        />
        <HealthRow
          label="Interruptions, last 30 days"
          value={
            incidents.opened === 0
              ? "None"
              : `${incidents.opened} — ${incidents.resolved === incidents.opened ? "all resolved" : `${incidents.resolved} resolved`}`
          }
          tone={incidents.opened === 0 || incidents.resolved === incidents.opened ? "good" : undefined}
        />
        <HealthRow
          label="Last checked"
          value={uptime.lastCheckedAt ? ago(uptime.lastCheckedAt, now) : "Not yet"}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Response time chart                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Thirty days of response time, as an area and a line.
 *
 * Hand-drawn SVG rather than a charting dependency, the same call
 * `RevenueChart` and the KPI sparkline already make: thirty points with one
 * axis label at each end and no interaction is not a chart problem. The fill
 * uses `currentColor` at low opacity so it follows whatever accent the client
 * has chosen without this component knowing what that is.
 */
export function ResponseChart({ points, className }: { points: readonly number[]; className?: string }) {
  if (points.length < 3) {
    return (
      <p className={cn("text-row text-muted-foreground", className)}>
        Not enough measurements yet — the chart fills in over the first few days.
      </p>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  // 2 units of headroom top and bottom so the stroke is never clipped.
  const at = (v: number, i: number) => `${(i / (points.length - 1)) * 100},${46 - ((v - min) / span) * 42 - 2}`;
  const line = points.map(at).join(" ");

  return (
    <div className={className}>
      <svg
        viewBox="0 0 100 48"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Response time over the last ${points.length} days, from ${min} to ${max} milliseconds`}
        className="h-28 w-full text-primary"
      >
        <polygon points={`0,48 ${line} 100,48`} fill="currentColor" opacity="0.09" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1.5 flex justify-between text-meta text-muted-foreground">
        <span>{points.length} days ago</span>
        <span>
          {min}–{max} ms
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What we have been doing                                                    */
/* -------------------------------------------------------------------------- */

export function ActivityFeed({ items }: { items: ClientDashboard["activity"] }) {
  if (items.length === 0) {
    return (
      <p className="text-row text-muted-foreground">
        Nothing to report yet. As we work on your account it will appear here.
      </p>
    );
  }

  return (
    <ol className="space-y-0">
      {items.map((item) => (
        <li key={item.id} className="flex gap-3 border-b py-3 last:border-b-0 last:pb-0">
          <span
            aria-hidden
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-fg"
          >
            <CheckCircle2 strokeWidth={1.75} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">
              {item.link ? (
                <Link href={item.link} className="hover:underline">
                  {item.title}
                </Link>
              ) : (
                item.title
              )}
            </span>
            {item.body ? <span className="mt-0.5 block text-meta text-muted-foreground">{item.body}</span> : null}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">{formatDate(item.createdAt)}</span>
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* This month, in numbers                                                     */
/* -------------------------------------------------------------------------- */

function Figure({ value, label, trend }: { value: string; label: string; trend?: DashboardTrend | null }) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <p className="text-figure font-semibold tracking-[-0.015em] tabular-nums">{value}</p>
      <p className="mt-0.5 text-meta text-muted-foreground">{label}</p>
      {trend ? (
        <p className="mt-1 text-meta">
          <Trend trend={trend} suffix="vs last month" />
        </p>
      ) : null}
    </div>
  );
}

export function MonthInNumbers({ data }: { data: ClientDashboard }) {
  const { uptime, support, work, contentPublishedThisWindow } = data;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Figure
        value={uptime.responseMs === null ? "—" : `${uptime.responseMs}ms`}
        label="Average response"
        trend={uptime.responseTrend}
      />
      <Figure value={String(work.doneThisWindow)} label="Jobs completed" />
      <Figure value={String(support.resolvedThisWindow)} label="Requests resolved" />
      <Figure
        value={support.firstResponseHours === null ? "—" : `${support.firstResponseHours}h`}
        label="Average first reply"
      />
      {contentPublishedThisWindow > 0 ? (
        <Figure value={String(contentPublishedThisWindow)} label="Posts published" />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Anything owing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Shown only when money is actually outstanding. A permanent "£0 owing" tile
 * would be a bill on a client's homepage every day of the year.
 */
export function OutstandingNotice({ data }: { data: ClientDashboard }) {
  const { outstandingPence, outstandingCount } = data.invoices;
  if (outstandingPence <= 0) return null;

  return (
    <Link
      href="/portal/invoices"
      className="flex items-center gap-3 rounded-2xl border border-warning-border bg-warning-bg px-4 py-3 text-warning-fg transition-opacity hover:opacity-90"
    >
      <Clock aria-hidden strokeWidth={1.75} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1 text-row">
        <span className="font-semibold">
          {outstandingCount === 1 ? "An invoice is" : `${outstandingCount} invoices are`} awaiting payment
        </span>{" "}
        — {formatPence(outstandingPence)}.
      </span>
      <span aria-hidden className="shrink-0">→</span>
    </Link>
  );
}
