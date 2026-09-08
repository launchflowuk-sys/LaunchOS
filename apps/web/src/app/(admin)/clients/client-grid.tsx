import type { ClientListRow } from "@launchos/core";
import { Globe, Network } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";

/**
 * The client book as cards rather than rows.
 *
 * The table is the better tool when you are comparing a column — who is
 * `past_due`, who has no support address. The grid is the better tool when you
 * are looking for one client by name, which is what the book is mostly used
 * for, so both exist and the URL decides.
 *
 * The whole card is the link. A card that only responds on its title is the
 * one thing people reliably complain about in a grid, and a nested link inside
 * a link is invalid HTML — so the counts and the pill are plain text and the
 * anchor wraps everything.
 */
export function ClientGrid({ clients }: { clients: readonly ClientListRow[] }) {
  return (
    <ul className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {clients.map((client) => (
        <li key={client.id} className="min-w-0">
          <Link
            href={`/clients/${client.id}`}
            className="flex h-full min-w-0 flex-col rounded-[20px] border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 text-base font-semibold break-words">{client.name}</h3>
              <StatusBadge value={client.status} className="shrink-0" />
            </div>

            {/* `break-all` because a support address is one long unbreakable
                token and would otherwise be the thing that widens the card. */}
            <p className="mt-1 text-meta break-all text-muted-foreground">
              {client.supportEmail ?? client.email ?? client.slug}
            </p>

            <div className="mt-auto flex flex-wrap items-center gap-4 pt-5 text-meta text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Globe aria-hidden className="size-4" strokeWidth={1.9} />
                <span className="tabular-nums">{client.siteCount}</span>
                {client.siteCount === 1 ? "website" : "websites"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Network aria-hidden className="size-4" strokeWidth={1.9} />
                <span className="tabular-nums">{client.domainCount}</span>
                {client.domainCount === 1 ? "domain" : "domains"}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
