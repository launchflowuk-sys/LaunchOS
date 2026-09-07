import { attributionOf, attributionSummary, costPerLeadByCampaign, leadCampaignCounts, type LeadRow, listLeads } from "@launchos/core";
import { schema } from "@launchos/db";
import type { LeadStatus } from "@launchos/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { UserPlus } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { CostPerLeadStrip } from "./cost-per-lead-strip";
import { LeadStatusBadge } from "./lead-status-badge";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, LEAD_STATUSES } from "./schemas";

export const dynamic = "force-dynamic";

const FILTERS = ["all", ...LEAD_STATUSES] as const;
type Filter = (typeof FILTERS)[number];

const COLUMNS: readonly DataListColumn<LeadRow>[] = [
  {
    key: "name",
    header: "Lead",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/leads/${row.id}`} className="hover:underline">
          {row.business ?? row.name}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">
          {row.business ? `${row.name} · ` : ""}
          {row.email ?? row.phone ?? "no contact details"}
        </span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <LeadStatusBadge status={row.status} /> },
  { key: "source", header: "Source", cell: (row) => LEAD_SOURCE_LABEL[row.source] ?? row.source },
  {
    key: "campaign",
    header: "Campaign",
    cell: (row) => {
      const attribution = attributionOf(row.metadata);
      if (attribution.utmCampaign) {
        return (
          <>
            <Link href={{ pathname: "/leads", query: { campaign: attribution.utmCampaign } }} className="hover:underline">
              {attribution.utmCampaign}
            </Link>
            {attribution.utmSource ? (
              <span className="block text-meta text-muted-foreground">
                {[attribution.utmSource, attribution.utmMedium].filter(Boolean).join(" / ")}
              </span>
            ) : null}
          </>
        );
      }
      return <span className="text-muted-foreground">{attributionSummary(attribution) ?? "—"}</span>;
    },
  },
  { key: "received", header: "Received", className: "whitespace-nowrap", cell: (row) => formatDateTime(row.createdAt) },
];

/** How many leads sit in each status, for the count row under the header. */
async function countsByStatus(organisationId: string): Promise<Record<LeadStatus, number>> {
  const rows = await getDb()
    .select({ status: schema.leads.status, value: count() })
    .from(schema.leads)
    .where(and(eq(schema.leads.organisationId, organisationId), isNull(schema.leads.deletedAt)))
    .groupBy(schema.leads.status);
  const counts: Record<LeadStatus, number> = { new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 };
  for (const row of rows) counts[row.status] = row.value;
  return counts;
}

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status : "all";
  const filter: Filter = FILTERS.includes(statusParam as Filter) ? (statusParam as Filter) : "all";
  const campaign = typeof params.campaign === "string" && params.campaign.trim().length > 0 ? params.campaign.trim().slice(0, 200) : null;
  const page = pageParam(params.page);

  // The same thirty days the campaign pills cover, as the ISO calendar dates
  // the ad platforms report in.
  const today = new Date();
  const since = new Date(today.getTime() - 29 * 86_400_000);
  const isoDay = (value: Date) => value.toISOString().slice(0, 10);

  const [{ leads: fetched }, counts, campaigns, costPerLead] = await Promise.all([
    listLeads(getDb(), session.organisationId, {
      ...(filter === "all" ? {} : { status: filter }),
      ...(campaign ? { utmCampaign: campaign } : {}),
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countsByStatus(session.organisationId),
    leadCampaignCounts(getDb(), session.organisationId, { days: 30 }),
    costPerLeadByCampaign(getDb(), session.organisationId, { from: isoDay(since), to: isoDay(today) }),
  ]);
  const attributed = campaigns.campaigns.filter((row) => row.campaign !== null);
  const hasNext = fetched.length > PAGE_SIZE;
  const rows = hasNext ? fetched.slice(0, PAGE_SIZE) : fetched;

  return (
    <>
      <PageHeader
        title="Leads"
        description="New business coming in: the website form, self-serve sign-ups and anyone you add by hand. Convert the ones that say yes."
        category="delivery"
      />

      {/* The counts are the page's one number: how many are waiting on a call
          back, and how the rest ended up. Links rather than pills so a tap
          filters the list. */}
      <ul className="mb-4 flex flex-wrap gap-2" aria-label="Leads by status">
        {LEAD_STATUSES.map((status) => (
          <li key={status}>
            <Link
              href={{ pathname: "/leads", query: { status } }}
              aria-current={filter === status ? "page" : undefined}
              className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-primary-soft"
            >
              <span>{LEAD_STATUS_LABEL[status]}</span>
              <span className="font-semibold tabular-nums">{counts[status]}</span>
            </Link>
          </li>
        ))}
      </ul>

      {/* Where the last thirty days of leads came from, by UTM campaign:
          the number that says whether an ad is earning its keep. Each pill
          filters the list; the current one is outlined. */}
      {attributed.length > 0 ? (
        <div className="mb-4">
          <p className="label-caps mb-2 text-muted-foreground">Campaigns, last {campaigns.days} days</p>
          <ul className="flex flex-wrap gap-2" aria-label="Leads by campaign">
            {attributed.map((row) => (
              <li key={row.campaign}>
                <Link
                  href={{ pathname: "/leads", query: { status: filter, campaign: row.campaign } }}
                  aria-current={campaign === row.campaign ? "page" : undefined}
                  className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-primary-soft"
                >
                  <span>{row.campaign}</span>
                  <span className="font-semibold tabular-nums">{row.leads}</span>
                  {row.converted > 0 ? <span className="text-meta text-muted-foreground">{row.converted} won</span> : null}
                </Link>
              </li>
            ))}
            {campaign ? (
              <li>
                <Link href={{ pathname: "/leads", query: { status: filter } }} className="inline-flex items-center rounded-full border border-dashed px-3 py-1 text-sm text-muted-foreground hover:text-foreground">
                  Clear campaign
                </Link>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {/* What the enquiries cost. Below the campaign pills because it is the
          same thirty days read a second way: the pills say where they came
          from, this says what each one was worth paying. */}
      <CostPerLeadStrip report={costPerLead} days={campaigns.days} />

      <form action="/leads">
        {campaign ? <input type="hidden" name="campaign" value={campaign} /> : null}
        <FilterBar>
          <ToolbarField label="Status" htmlFor="status" className="sm:w-44">
            <NativeSelect id="status" name="status" defaultValue={filter}>
              {FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : LEAD_STATUS_LABEL[value]}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Leads"
        empty={
          <EmptyState icon={UserPlus}>
            {page > 1
              ? "There are no leads on this page. Go back to a newer page."
              : campaign
                ? `No leads from the "${campaign}" campaign${filter === "all" ? "" : ` that are ${LEAD_STATUS_LABEL[filter].toLowerCase()}`}.`
                : filter === "all"
                  ? "No leads yet. The website form and self-serve sign-ups land here."
                  : `No ${LEAD_STATUS_LABEL[filter].toLowerCase()} leads.`}
          </EmptyState>
        }
      />
      <Pager basePath="/leads" query={{ status: filter, ...(campaign ? { campaign } : {}) }} page={page} hasNext={hasNext} />
    </>
  );
}
