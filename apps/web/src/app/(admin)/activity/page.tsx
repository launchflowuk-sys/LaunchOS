import { listActivity, listClients } from "@launchos/core";
import { Activity } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { isInAppPath } from "@/lib/in-app-path";
import { iconOf, sourceLabel, timeAgo, TONE_STRIPE, TONE_TILE, toneOf } from "@/lib/notification-kind";
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

  // Grouped by day rather than printed as one long list: a timeline answers
  // "what happened, and when" and the date is half of that. Insertion order is
  // preserved because the rows already arrive newest first.
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = dayLabel(row.createdAt, now);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }

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

      {/* Filtering by client is the only question this screen gets asked, and
          links rather than a form so a filtered view is shareable. */}
      {clients.length > 1 ? (
        <div className="mb-6 flex min-w-0 flex-wrap gap-2">
          <Link
            href="/activity"
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-meta font-medium transition-colors",
              clientId ? "hover:bg-muted" : "border-primary bg-primary text-primary-foreground",
            )}
          >
            Everyone
          </Link>
          {clients.map((client) => (
            <Link
              key={client.id}
              href={`/activity?client=${client.id}`}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-meta font-medium transition-colors",
                clientId === client.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              {client.name}
            </Link>
          ))}
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
          {[...byDay.entries()].map(([day, entries]) => (
            <section key={day} className="min-w-0">
              <h2 className="label-caps pb-2 text-muted-foreground">{day}</h2>
              <ul className="min-w-0 space-y-0.5">
                {entries.map((row) => {
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
