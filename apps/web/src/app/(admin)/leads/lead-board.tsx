import type { LeadRow } from "@launchos/core";
import { attributionOf, attributionSummary } from "@launchos/core";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { LeadStatusForm } from "./lead-status-form";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, LEAD_STATUSES } from "./schemas";

/**
 * New business as a pipeline rather than a list.
 *
 * The list answers "what came in and when"; this answers "where is everything
 * stuck", which is the question that actually gets a lead called back. Every
 * status gets a lane, `lost` included — a lane of lost leads is the honest
 * shape of a pipeline, and hiding it makes the board flatter than the business.
 *
 * Lanes scroll sideways inside their own box and each lane scrolls its own
 * cards. Nothing here may widen the page: `min-w-0` on the scroller,
 * `shrink-0` on each lane. That rule is asserted by the 375px sweep.
 */
export function LeadBoard({ leads, statuses }: { leads: readonly LeadRow[]; statuses: readonly string[] }) {
  return (
    <div className="-mx-1 flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
      {LEAD_STATUSES.map((column) => {
        const cards = leads.filter((lead) => lead.status === column);
        return (
          <section
            key={column}
            aria-label={LEAD_STATUS_LABEL[column]}
            className="w-72 shrink-0 snap-start rounded-[20px] bg-muted/60 p-2"
          >
            <header className="mb-2 flex items-center justify-between gap-2 px-1.5 py-1">
              <h2 className="label-caps truncate text-muted-foreground">{LEAD_STATUS_LABEL[column]}</h2>
              <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{cards.length}</span>
            </header>

            <div className="grid max-h-[70vh] gap-2 overflow-y-auto">
              {cards.length === 0 ? (
                <p className="px-1.5 py-6 text-center text-meta text-muted-foreground">Nothing here.</p>
              ) : null}

              {cards.map((lead) => {
                const attribution = attributionOf(lead.metadata);
                const campaign = attribution.utmCampaign ?? attributionSummary(attribution);
                return (
                  <article key={lead.id} className="rounded-[14px] border bg-card p-3">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="block min-w-0 text-sm font-semibold break-words hover:underline"
                    >
                      {lead.business ?? lead.name}
                    </Link>
                    <p className="mt-0.5 truncate text-meta text-muted-foreground">
                      {lead.business ? `${lead.name} · ` : ""}
                      {lead.email ?? lead.phone ?? "no contact details"}
                    </p>

                    <p className="mt-2 truncate text-meta text-muted-foreground">
                      {LEAD_SOURCE_LABEL[lead.source] ?? lead.source}
                      {campaign ? ` · ${campaign}` : ""}
                    </p>
                    <p className="truncate text-meta text-muted-foreground">{formatDateTime(lead.createdAt)}</p>

                    <div className="mt-3">
                      <LeadStatusForm leadId={lead.id} status={lead.status} statuses={statuses} />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
