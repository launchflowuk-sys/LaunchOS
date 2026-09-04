import { countUnreadNotifications, listNotifications } from "@launchos/core";
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
        className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700"
      >
        Notifications
        {unread > 0 ? (
          <span className="rounded-full bg-neutral-900 px-1.5 text-[11px] font-medium tabular-nums text-white">{unread}</span>
        ) : null}
      </summary>

      <div className="absolute right-0 top-11 z-40 w-80 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-neutral-500">Nothing to read.</p>
        ) : (
          <>
            {rows.map((row) => (
              <div key={row.id} className="rounded-md px-2 py-2 hover:bg-neutral-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {isInAppPath(row.link) ? (
                      <Link href={row.link} className="block truncate text-sm font-medium text-neutral-900 hover:underline">
                        {row.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-neutral-900">{row.title}</p>
                    )}
                    {row.body ? <p className="mt-0.5 truncate text-xs text-neutral-500">{row.body}</p> : null}
                    <p className="mt-0.5 text-[11px] text-neutral-400">{formatDateTime(row.createdAt)}</p>
                  </div>
                  {row.readAt ? null : (
                    <form action={markOneRead}>
                      <input type="hidden" name="notificationId" value={row.id} />
                      <button type="submit" className="text-xs text-neutral-500 hover:text-neutral-900">
                        Mark read
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ))}
            {unread > 0 ? (
              <form action={markAllRead} className="border-t border-neutral-200 pt-2">
                <button type="submit" className="w-full rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100">
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
