import { clientDashboard, DASHBOARD_WINDOW_DAYS } from "@launchos/core";
import {
  ArrowUpRight, CalendarDays, FileText, Globe, Image as ImageIcon, MessageCircle, Plus, Search, Sparkles,
} from "lucide-react";
import Link from "next/link";
import {
  ActivityFeed, DashboardTiles, MonthInNumbers, OutstandingNotice, ResponseChart, WebsiteHealth,
} from "@/components/portal/dashboard";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * The client's dashboard.
 *
 * Answers "is everything alright?" before a word has to be read — the state of
 * the website, the domain, the plan and the open work, across the top — then
 * the detail underneath for anyone who wants it.
 *
 * Every figure comes from one `clientDashboard` read against one `now`, so
 * nothing on the page can contradict anything else on it. Where a figure has
 * never been measured it says so; there is no placeholder data anywhere on
 * this screen, which is the difference between a dashboard a client trusts and
 * one they learn to ignore.
 */

/** What a client most often comes here to ask for. Ordered by how often they ask. */
const REQUESTS = [
  { label: "A change to my website", icon: Globe, href: "/portal/support/new?about=website" },
  { label: "New page or content", icon: FileText, href: "/portal/support/new?about=content" },
  { label: "Help being found on Google", icon: Search, href: "/portal/support/new?about=seo" },
  { label: "Images or design work", icon: ImageIcon, href: "/portal/support/new?about=design" },
  { label: "Something else entirely", icon: Sparkles, href: "/portal/support/new" },
] as const;

/** "Good morning" is worth getting right — it is the first thing on the page. */
function greeting(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(now),
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function PortalHomePage() {
  const session = await requireClient();
  const now = new Date();
  const data = await clientDashboard(getDb(), session.organisationId, session.clientId, now);

  const firstName = session.name.trim().split(/\s+/)[0] || session.name;
  const today = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
  }).format(now);

  return (
    <div className="space-y-6">
      {/* Not `PageHeader`: that carries a category dot and a one-line
          description, and this is a greeting. A client opens the portal a few
          times a year and should be met rather than filed. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-title font-bold tracking-[-0.015em]">
            {greeting(now)}, {firstName}
          </h1>
          <p className="mt-1 text-base text-muted-foreground">
            Here&rsquo;s what&rsquo;s happening with{" "}
            <span className="font-medium text-foreground">{session.clientName}</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="hidden text-meta text-muted-foreground lg:block">{today}</p>
          {data.site ? (
            <Button asChild variant="secondary">
              <a href={data.site.primaryUrl} target="_blank" rel="noreferrer noopener">
                View website
                <ArrowUpRight aria-hidden strokeWidth={2} className="size-4" />
              </a>
            </Button>
          ) : null}
          <Button asChild>
            <Link href="/portal/support/new">
              <Plus aria-hidden strokeWidth={2} className="size-4" />
              Request something
            </Link>
          </Button>
        </div>
      </div>

      {/* Money owing goes above everything. It is the one thing on this page a
          client would be annoyed to find out about later. */}
      <OutstandingNotice data={data} />

      <DashboardTiles data={data} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <WebsiteHealth data={data} now={now} />

        <div className="rounded-2xl border bg-card p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-figure font-semibold tracking-[-0.01em]">What we&rsquo;ve been doing</h2>
            <Link href="/portal/tasks" className="shrink-0 text-meta font-medium text-primary hover:underline">
              See all
            </Link>
          </div>
          <div className="mt-3">
            <ActivityFeed items={data.activity} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-figure font-semibold tracking-[-0.01em]">Your last {DASHBOARD_WINDOW_DAYS} days</h2>
          <p className="text-meta text-muted-foreground">
            Measured from our own checks — not an estimate.
          </p>
        </div>

        <div className="mt-4">
          <MonthInNumbers data={data} />
        </div>

        {data.uptime.responseSeries.length >= 3 ? (
          <div className="mt-5 border-t pt-5">
            <p className="text-row font-medium">How quickly your site answered</p>
            <p className="mt-0.5 text-meta text-muted-foreground">
              Lower is better. We check every few minutes, day and night.
            </p>
            <ResponseChart points={data.uptime.responseSeries} className="mt-3" />
          </div>
        ) : null}
      </div>

      {/* The way to a person, last on the page and the only saturated surface
          on it. Somebody who came here because something is wrong reaches this
          by scrolling past everything that is fine — which is the right order,
          because the tiles above may already have answered them. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="rounded-2xl border bg-card p-5 sm:p-6">
          <h2 className="text-figure font-semibold tracking-[-0.01em]">Need something?</h2>
          <p className="mt-1 text-row text-muted-foreground">
            Tell us what you need and we&rsquo;ll take care of it.
          </p>
          <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
            {REQUESTS.map((request) => (
              <li key={request.label}>
                <Link
                  href={request.href}
                  className="flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors hover:border-primary/40 hover:bg-primary-soft/40"
                >
                  <request.icon aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-row font-medium">{request.label}</span>
                  <span aria-hidden className="shrink-0 text-muted-foreground">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <aside className="min-w-0">
          <div className="rounded-2xl bg-primary p-6 text-primary-foreground">
            <span aria-hidden className="flex size-11 items-center justify-center rounded-[14px] bg-white/15">
              <CalendarDays className="size-5" strokeWidth={1.75} />
            </span>
            <h2 className="mt-4 text-figure font-bold leading-tight tracking-[-0.01em]">
              Rather talk it through?
            </h2>
            <p className="mt-2 text-row text-primary-foreground/85">
              Book a short video call at a time that suits you.
            </p>
            <Button asChild size="lg" variant="secondary" className="mt-5 w-full">
              <Link href="/book">
                Book a call
                <span aria-hidden>→</span>
              </Link>
            </Button>
            <div className="mt-5 border-t border-white/20 pt-5">
              <Link href="/portal/support/new" className="group flex items-start gap-3">
                <MessageCircle aria-hidden strokeWidth={1.75} className="mt-0.5 size-5 shrink-0" />
                <span>
                  <span className="block font-semibold group-hover:underline">Prefer to message us?</span>
                  <span className="block text-meta text-primary-foreground/80">
                    {data.support.firstResponseHours === null
                      ? "We usually reply the same day."
                      : `We usually reply within ${Math.max(1, Math.round(data.support.firstResponseHours))} hours.`}
                  </span>
                </span>
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
