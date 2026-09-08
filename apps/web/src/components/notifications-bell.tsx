import { countUnreadNotifications, listNotifications } from "@launchos/core";
import { Bell, Check } from "lucide-react";
import Link from "next/link";
import { markAllRead, markOneRead } from "@/app/(admin)/notifications/actions";
import { getDb } from "@/lib/db";
import { isInAppPath } from "@/lib/in-app-path";
import {
  iconOf,
  sourceLabel,
  timeAgo,
  TONE_STRIPE,
  TONE_TILE,
  toneOf,
} from "@/lib/notification-kind";
import type { AdminSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const LIST_LIMIT = 15;

type Row = Awaited<ReturnType<typeof listNotifications>>[number];

/**
 * One notification, told apart from its neighbours at a glance.
 *
 * The previous version rendered every row as the same grey two lines with a
 * full timestamp and the words "Mark read" beside it, so a failed payment, a
 * booked meeting and a server error were visually identical and the panel was
 * not worth opening. Three things fix that and they are all about *reading*
 * rather than decoration: a tone stripe and a tinted icon so urgency lands
 * before any word is read; the title allowed two lines instead of being
 * truncated mid-word; and "2h ago" in place of "8 Sept 2026, 07:00".
 */
function NotificationRow({ row }: { row: Row }) {
  const tone = toneOf(row.kind);
  const Icon = iconOf(row.kind);
  const unread = !row.readAt;

  return (
    <li className="relative flex min-w-0 gap-3 rounded-[14px] py-2.5 pr-2 pl-3 transition-colors hover:bg-muted/60">
      {/* The stripe is the fastest signal in the panel: colour, at a fixed
          position, before the eye reaches any text. */}
      <span aria-hidden className={cn("absolute top-3 bottom-3 left-0 w-[3px] rounded-full", TONE_STRIPE[tone])} />

      <span
        aria-hidden
        className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px]", TONE_TILE[tone])}
      >
        <Icon className="size-[1.05rem]" strokeWidth={1.9} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {/* Two lines, wrapping. Truncating a title to one line is what made
                "Web error: /(marketing)/site/cont…" unreadable — the useful half
                of that sentence is the half that was cut. */}
            {isInAppPath(row.link) ? (
              <Link href={row.link} className="line-clamp-2 text-sm font-semibold break-words hover:underline">
                {row.title}
              </Link>
            ) : (
              <p className="line-clamp-2 text-sm font-semibold break-words">{row.title}</p>
            )}
          </div>
          {unread ? (
            <form action={markOneRead} className="shrink-0">
              <input type="hidden" name="notificationId" value={row.id} />
              <button
                type="submit"
                // An icon, not the words "Mark read". On a 375px screen that
                // label was taking a third of every row from the text.
                aria-label={`Mark "${row.title}" as read`}
                title="Mark as read"
                className="flex size-7 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:border-success-fg hover:text-success-fg"
              >
                <Check aria-hidden className="size-3.5" strokeWidth={2.2} />
              </button>
            </form>
          ) : null}
        </div>

        {/* One line, unlike the title. The title is the thing that was
            unreadable before and it gets two; the body is supporting detail and
            a second line of it costs forty pixels on every row, which is the
            difference between five and eight fitting on a phone. */}
        {row.body ? <p className="mt-0.5 line-clamp-1 text-meta break-words text-muted-foreground">{row.body}</p> : null}

        <p className="mt-1 flex items-center gap-1.5 text-label text-muted-foreground">
          <span className="font-semibold tracking-wide uppercase">{sourceLabel(row.kind)}</span>
          <span aria-hidden>·</span>
          <span>{timeAgo(row.createdAt)}</span>
          {unread ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-semibold text-primary">New</span>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

/**
 * A `<details>` dropdown rather than a popover: the list is server-rendered on
 * every request, so the count can never drift from the rows below it.
 *
 * Rows are split into "Needs you" and "Everything else" rather than one flat
 * stream. Time order alone buries a payment failure under three booked
 * meetings, and the panel exists to answer one question — is there anything in
 * here I have to do something about — which a flat list cannot answer without
 * being read end to end.
 */
export async function NotificationsBell({ session }: { session: AdminSession }) {
  const db = getDb();
  const [unread, rows] = await Promise.all([
    countUnreadNotifications(db, session.organisationId, session.userId),
    listNotifications(db, session.organisationId, { userId: session.userId, limit: LIST_LIMIT }),
  ]);

  const needsYou = rows.filter((row) => {
    const tone = toneOf(row.kind);
    return tone === "critical" || tone === "attention";
  });
  const rest = rows.filter((row) => !needsYou.includes(row));

  return (
    <details className="relative [&[open]>summary>svg]:text-primary">
      <summary
        role="button"
        aria-label={`Notifications, ${unread} unread`}
        className="relative flex size-9 cursor-pointer list-none items-center justify-center rounded-[10px] border text-foreground transition-colors hover:bg-muted"
      >
        <Bell aria-hidden strokeWidth={1.9} className="size-4 transition-colors" />
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-danger-solid px-1 text-center text-[0.625rem] leading-4 font-semibold tabular-nums text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </summary>

      {/* On a phone this is a full-width sheet pinned under the top bar, not a
          320px dropdown hanging off the right edge — the old one covered the
          screen anyway, so it may as well use the width and be readable. */}
      <div
        className={cn(
          "fixed inset-x-3 top-[4.25rem] z-40 max-h-[75vh] overflow-y-auto rounded-[18px] border bg-popover p-2 shadow-lg",
          "sm:absolute sm:inset-x-auto sm:top-11 sm:right-0 sm:w-[24rem] sm:max-h-[32rem]",
        )}
      >
        {rows.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">Nothing to read.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 ? (
                <span className="text-meta text-muted-foreground">{unread} unread</span>
              ) : null}
            </div>

            {needsYou.length > 0 ? (
              <>
                <p className="label-caps px-2 pt-1 pb-1 text-danger-fg">Needs you</p>
                <ul className="grid gap-0.5">
                  {needsYou.map((row) => (
                    <NotificationRow key={row.id} row={row} />
                  ))}
                </ul>
              </>
            ) : null}

            {rest.length > 0 ? (
              <>
                <p className={cn("label-caps px-2 pb-1 text-muted-foreground", needsYou.length > 0 && "pt-3")}>
                  {needsYou.length > 0 ? "Everything else" : "Recent"}
                </p>
                <ul className="grid gap-0.5">
                  {rest.map((row) => (
                    <NotificationRow key={row.id} row={row} />
                  ))}
                </ul>
              </>
            ) : null}

            <div className="mt-2 grid gap-1 border-t pt-2">
              {unread > 0 ? (
                <form action={markAllRead}>
                  <button
                    type="submit"
                    className="w-full rounded-[10px] px-2 py-2 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Mark all read
                  </button>
                </form>
              ) : null}
              <Link
                href="/activity"
                className="rounded-[10px] px-2 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                See everything that happened
              </Link>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
