import { listPortalUpdates, portalSeenAt } from "@launchos/core";
import Link from "next/link";
import { markPortalSeenAction } from "@/app/(portal)/portal/bell-actions";
import { getDb } from "@/lib/db";
import { iconOf, timeAgo, TONE_TILE, toneOf } from "@/lib/notification-kind";
import type { ClientSession } from "@/lib/portal-session";
import { cn } from "@/lib/utils";
import { PortalBellShell } from "./portal-bell-shell";

/**
 * What has happened on the client's account lately.
 *
 * Every row is something they can already open from the nav — a reply on a
 * request, an invoice, a document, work on their site. Nothing is written to
 * build this list: it is read from those four screens' own queries, so it
 * cannot drift away from what they are allowed to see.
 */
export async function PortalBell({ session }: { session: ClientSession }) {
  const db = getDb();
  const since = await portalSeenAt(db, session.organisationId, session.userId);
  const { rows, unseen } = await listPortalUpdates(db, session.organisationId, session.clientId, {
    ...(since ? { since } : {}),
  });

  return (
    <PortalBellShell unseen={unseen} onOpen={markPortalSeenAction}>
      <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
        <p className="text-sm font-semibold">Updates</p>
        {unseen > 0 ? <span className="text-meta text-muted-foreground">{unseen} new</span> : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
          Nothing yet. We will show replies, invoices and work on your account here.
        </p>
      ) : (
        <ul className="grid gap-0.5">
          {rows.map((row) => {
            const tone = toneOf(row.kind);
            const Icon = iconOf(row.kind);
            return (
              <li key={row.id}>
                <Link
                  href={row.link}
                  className="flex min-w-0 gap-3 rounded-[14px] px-2 py-2.5 transition-colors hover:bg-muted"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px]",
                      TONE_TILE[tone],
                    )}
                  >
                    <Icon className="size-[1.05rem]" strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-sm font-semibold break-words">{row.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground">
                      {row.body ? (
                        <>
                          <span>{row.body}</span>
                          <span aria-hidden>·</span>
                        </>
                      ) : null}
                      <span>{timeAgo(row.at)}</span>
                      {row.unseen ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="font-semibold text-primary">New</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PortalBellShell>
  );
}
