import { listActivity, listClients } from "@launchos/core";
import { Activity, AlertTriangle, CalendarDays, Layers } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { isInAppPath } from "@/lib/in-app-path";
import { categoryOf, iconOf, sourceLabel, timeAgo, TONE_STRIPE, TONE_TILE, toneOf } from "@/lib/notification-kind";
import { CATEGORY_DOT, type Category } from "@/lib/categories";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = { title: "Activity" };

/**
 * Everything that has happened, newest first.
 *
 * The dashboard's "Recent activity" panel and the notifications bell both end
 * in a link to this page, and until now both of them 404'd — the timeline was
 * being written all along and there was nowhere to read it.
 *
 * Activity kinds share the `<domain>.<event>` shape that notifications use, so
 * the same derivation gives each row its colour and icon: nothing here is a
 * list of kinds anybody has to keep up to date, and a kind invented next month
 * arrives correctly filed.
 */

const LIMIT = 200;

/**
 * The order the groups appear in, and the words above them.
 *
 * Fixed rather than sorted by volume: a screen whose sections move around
 * between visits cannot be learned, and the thing somebody opens Activity to
 * find — did something break, did money move — should not slide down the page
 * on a quiet week.
 */
const GROUPS: readonly { category: Category; title: string; blurb: string }[] = [
  { category: "support", title: "Support", blurb: "Tickets, incidents and messages" },
  { category: "money", title: "Money", blurb: "Invoices, payments, subscriptions and proposals" },
  { category: "delivery", title: "Delivery", blurb: "Projects, tasks, sites, domains and content" },
  { category: "automation", title: "Automation", blurb: "Agents, approvals, the queue and the worker" },
  { category: "overview", title: "Leads and reporting", blurb: "Enquiries, meetings, ads and reports" },
  { category: "organisation", title: "People", blurb: "Team members and portal users" },
];

/** `2026-09-09` → "Today" / "Yesterday" / "Tuesday 9 September". */
function dayLabel(value: Date, now: Date): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(now) - day(value)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return value.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const session = await requireAdmin();
  const db = getDb();
  const params = await searchParams;
  const clientId = typeof params.client === "string" && params.client !== "" ? params.client : undefined;

  const [rows, clients] = await Promise.all([
    listActivity(db, session.organisationId, { limit: LIMIT, ...(clientId ? { clientId } : {}) }),
    listClients(db, session.organisationId, {}),
  ]);

  const now = new Date();
  const named = clients.find((client) => client.id === clientId);

  // Grouped by the part of the business it belongs to, not by day. A flat
  // timeline answers "what happened" and nothing else; the question actually
  // being asked of this screen is "is anything wrong, and where", and that is a
  // question about kind. The day is still on every row as "3h ago".
  const byCategory = new Map<Category, typeof rows>();
  for (const row of rows) {
    const key = categoryOf(row.kind);
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(row);
    else byCategory.set(key, [row]);
  }
  const groups = GROUPS.map((group) => ({ ...group, rows: byCategory.get(group.category) ?? [] }))
    .filter((group) => group.rows.length > 0);

  // Critical and attention together: the summary's job is to say whether
  // anything on this page needs a person, not to grade how badly.
  const needsAttention = rows.filter((row) => {
    const tone = toneOf(row.kind);
    return tone === "critical" || tone === "attention";
  }).length;
  const today = rows.filter((row) => dayLabel(row.createdAt, now) === "Today").length;

  return (
    <>
      <PageHeader
        title="Activity"
        description={
          named
            ? `Everything that has happened for ${named.name}.`
            : "Everything that has happened, across every client."
        }
      />

      {/* A select, not a row of pills. Twenty-eight clients made a wall of
          them that pushed the timeline below the fold, and picking one meant
          reading all of them. Still a GET to a URL, so a filtered view stays
          shareable. */}
      {clients.length > 1 ? (
        <form action="/activity" className="mb-6 flex flex-wrap items-end gap-2">
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="activity-client" className="label-caps block text-muted-foreground">
              Client
            </label>
            <NativeSelect id="activity-client" name="client" defaultValue={clientId ?? ""} className="min-w-64">
              <option value="">Everyone</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="secondary">Show</Button>
          {clientId ? (
            <Button asChild variant="ghost">
              <Link href="/activity">Clear</Link>
            </Button>
          ) : null}
        </form>
      ) : null}

      {rows.length > 0 ? (
        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Events"
            value={rows.length}
            hint={rows.length === LIMIT ? `The most recent ${LIMIT}` : "Everything on record"}
            category="overview"
            icon={Layers}
          />
          <StatCard
            label="Needs attention"
            value={needsAttention}
            hint={needsAttention === 0 ? "Nothing is asking for you" : "Failures and warnings in this view"}
            category="support"
            icon={AlertTriangle}
            attention={needsAttention > 0}
          />
          <StatCard
            label="Today"
            value={today}
            hint={today === 0 ? "Nothing yet today" : "Since midnight"}
            category="overview"
            icon={CalendarDays}
          />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState icon={Activity}>
          {named
            ? `Nothing has happened for ${named.name} yet.`
            : "Nothing has happened yet. Add a client to start the timeline."}
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.category} className="min-w-0 rounded-[20px] border bg-card p-5">
              <div className="mb-3 flex items-baseline gap-2">
                <span aria-hidden className={cn("size-2 shrink-0 translate-y-[-1px] rounded-full", CATEGORY_DOT[group.category])} />
                <h2 className="text-base font-semibold tracking-tight">{group.title}</h2>
                <span className="text-meta text-muted-foreground">{group.rows.length}</span>
                <span className="ml-auto hidden text-meta text-muted-foreground sm:block">{group.blurb}</span>
              </div>
              <ul className="min-w-0 space-y-0.5">
                {group.rows.map((row) => {
                  const tone = toneOf(row.kind);
                  const Icon = iconOf(row.kind);
                  return (
                    <li
                      key={row.id}
                      className="relative flex min-w-0 gap-3 rounded-[14px] py-3 pr-2 pl-3 transition-colors hover:bg-muted/60"
                    >
                      <span
                        aria-hidden
                        className={cn("absolute top-3.5 bottom-3.5 left-0 w-[3px] rounded-full", TONE_STRIPE[tone])}
                      />
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px]",
                          TONE_TILE[tone],
                        )}
                      >
                        <Icon className="size-[1.05rem]" strokeWidth={1.9} />
                      </span>

                      <div className="min-w-0 flex-1">
                        {isInAppPath(row.link) ? (
                          <Link href={row.link} className="text-sm font-semibold break-words hover:underline">
                            {row.title}
                          </Link>
                        ) : (
                          <p className="text-sm font-semibold break-words">{row.title}</p>
                        )}
                        {row.body ? (
                          <p className="mt-0.5 text-meta break-words text-muted-foreground">{row.body}</p>
                        ) : null}
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground">
                          <span className="font-semibold tracking-wide uppercase">{sourceLabel(row.kind)}</span>
                          <span aria-hidden>·</span>
                          <span>{timeAgo(row.createdAt, now)}</span>
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {rows.length === LIMIT ? (
            <p className="text-meta text-muted-foreground">
              Showing the most recent {LIMIT}. Filter by client to look further back.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}
