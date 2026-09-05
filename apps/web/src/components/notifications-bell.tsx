import { countUnreadNotifications, listNotifications } from "@launchos/core";
import { Bell } from "lucide-react";
import Link from "next/link";
import { markAllRead, markOneRead } from "@/app/(admin)/notifications/actions";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { isInAppPath } from "@/lib/in-app-path";
import type { AdminSession } from "@/lib/session";

const LIST_LIMIT = 10;

/**
 * A `<details>` dropdown rather than a popover: the list is server-rendered on
 * every request, so the count can never drift from the rows below it.
 */
export async function NotificationsBell({ session }: { session: AdminSession }) {
  const db = getDb();
  const [unread, rows] = await Promise.all([
    countUnreadNotifications(db, session.organisationId, session.userId),
    listNotifications(db, session.organisationId, { userId: session.userId, limit: LIST_LIMIT }),
  ]);

  return (
    <details className="relative">
      <summary
        role="button"
        aria-label={`Notifications, ${unread} unread`}
        className="relative flex size-9 cursor-pointer list-none items-center justify-center rounded-md border text-foreground transition-colors hover:bg-muted"
      >
        <Bell aria-hidden strokeWidth={1.75} className="size-4" />
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-danger-fg px-1 text-center text-[0.625rem] leading-4 font-semibold tabular-nums text-white"
          >
            {unread}
          </span>
        ) : null}
      </summary>

      <div className="absolute top-11 right-0 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-2 shadow-lg">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing to read.</p>
        ) : (
          <>
            {rows.map((row) => (
              <div key={row.id} className="rounded-md px-2 py-2 transition-colors hover:bg-muted">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {isInAppPath(row.link) ? (
                      <Link href={row.link} className="block truncate text-sm font-medium hover:underline">
                        {row.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium">{row.title}</p>
                    )}
                    {row.body ? <p className="mt-0.5 truncate text-meta text-muted-foreground">{row.body}</p> : null}
                    <p className="mt-0.5 text-meta text-muted-foreground">{formatDateTime(row.createdAt)}</p>
                  </div>
                  {row.readAt ? null : (
                    <form action={markOneRead}>
                      <input type="hidden" name="notificationId" value={row.id} />
                      <button type="submit" className="text-meta text-muted-foreground transition-colors hover:text-foreground">
                        Mark read
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ))}
            {unread > 0 ? (
              <form action={markAllRead} className="border-t pt-2">
                <button type="submit" className="w-full rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted">
                  Mark all read
                </button>
              </form>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
