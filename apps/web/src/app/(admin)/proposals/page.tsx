import { formatPence, listProposals, type ProposalRow } from "@launchos/core";
import { schema } from "@launchos/db";
import type { ProposalStatus } from "@launchos/db/schema";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { FileSignature } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdminWith } from "@/lib/permissions";
import { ProposalStatusBadge } from "./proposal-status-badge";
import { PROPOSAL_STATUS_LABEL, PROPOSAL_STATUSES, SHAPE_OPTION_LABEL } from "./schemas";

export const dynamic = "force-dynamic";

const FILTERS = ["all", ...PROPOSAL_STATUSES] as const;
type Filter = (typeof FILTERS)[number];

/** Who a proposal is for, resolved in one query per list rather than one per row. */
type SubjectName = { label: string; href: string };

const COLUMNS: readonly DataListColumn<{ proposal: ProposalRow; subject: SubjectName | null }>[] = [
  {
    key: "reference",
    header: "Proposal",
    primary: true,
    cell: ({ proposal }) => (
      <>
        <Link href={`/proposals/${proposal.id}`} className="hover:underline">
          {proposal.title}
        </Link>
        <span className="block font-mono text-meta font-normal text-muted-foreground">{proposal.reference}</span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: ({ proposal }) => <ProposalStatusBadge status={proposal.status} /> },
  {
    key: "for",
    header: "For",
    cell: ({ subject }) =>
      subject ? (
        <Link href={subject.href} className="hover:underline">
          {subject.label}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "price",
    header: "First year",
    numeric: true,
    cell: ({ proposal }) => {
      const { setupPence, monthlyPence, oneOffPence } = proposal.pricing;
      return formatPence(setupPence + oneOffPence + monthlyPence * 12);
    },
  },
  { key: "shape", header: "Shape", hideOnMobile: true, cell: ({ proposal }) => SHAPE_OPTION_LABEL[proposal.pricing.shape] },
  {
    key: "valid",
    header: "Valid until",
    className: "whitespace-nowrap",
    cell: ({ proposal }) => (proposal.validUntil ? formatDate(`${proposal.validUntil}T12:00:00Z`) : "No end date"),
  },
];

/** How many proposals sit in each status, for the filter row under the header. */
async function countsByStatus(organisationId: string): Promise<Record<ProposalStatus, number>> {
  const rows = await getDb()
    .select({ status: schema.proposals.status, value: count() })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.organisationId, organisationId), isNull(schema.proposals.deletedAt)))
    .groupBy(schema.proposals.status);
  const counts: Record<ProposalStatus, number> = { draft: 0, sent: 0, viewed: 0, accepted: 0, declined: 0, expired: 0 };
  for (const row of rows) counts[row.status] = row.value;
  return counts;
}

/** The lead or client names for a page of proposals, in two queries rather than 2n. */
async function subjectsFor(organisationId: string, proposals: readonly ProposalRow[]): Promise<Map<string, SubjectName>> {
  const clientIds = [...new Set(proposals.map((p) => p.clientId).filter((id): id is string => id !== null))];
  const leadIds = [...new Set(proposals.map((p) => p.leadId).filter((id): id is string => id !== null))];
  const db = getDb();
  const [clients, leads] = await Promise.all([
    clientIds.length === 0
      ? []
      : db.select({ id: schema.clients.id, name: schema.clients.name })
          .from(schema.clients)
          .where(and(eq(schema.clients.organisationId, organisationId), inArray(schema.clients.id, clientIds))),
    leadIds.length === 0
      ? []
      : db.select({ id: schema.leads.id, name: schema.leads.name, business: schema.leads.business })
          .from(schema.leads)
          .where(and(eq(schema.leads.organisationId, organisationId), inArray(schema.leads.id, leadIds))),
  ]);
  const clientById = new Map(clients.map((row) => [row.id, row.name]));
  const leadById = new Map(leads.map((row) => [row.id, row.business ?? row.name]));

  const out = new Map<string, SubjectName>();
  for (const proposal of proposals) {
    const client = proposal.clientId ? clientById.get(proposal.clientId) : undefined;
    if (client) {
      out.set(proposal.id, { label: client, href: `/clients/${proposal.clientId}` });
      continue;
    }
    const lead = proposal.leadId ? leadById.get(proposal.leadId) : undefined;
    if (lead) out.set(proposal.id, { label: lead, href: `/leads/${proposal.leadId}` });
  }
  return out;
}

export default async function ProposalsPage({ searchParams }: PageProps<"/proposals">) {
  const session = await requireAdminWith("billing");
  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status : "all";
  const filter: Filter = FILTERS.includes(statusParam as Filter) ? (statusParam as Filter) : "all";

  const [proposals, counts] = await Promise.all([
    listProposals(getDb(), session.organisationId, { ...(filter === "all" ? {} : { status: filter }), limit: 200 }),
    countsByStatus(session.organisationId),
  ]);
  const subjects = await subjectsFor(session.organisationId, proposals);
  const rows = proposals.map((proposal) => ({ proposal, subject: subjects.get(proposal.id) ?? null }));

  return (
    <>
      <PageHeader
        title="Proposals"
        description="Priced offers to leads and clients. A proposal is frozen once it goes out — to change one, write another."
        category="delivery"
        actions={
          <Button asChild>
            <Link href="/proposals/new">New proposal</Link>
          </Button>
        }
      />

      {/* The counts are the page's one number: how many are out with somebody,
          and how the rest ended up. Links rather than pills so a tap filters. */}
      <ul className="mb-4 flex flex-wrap gap-2" aria-label="Proposals by status">
        {PROPOSAL_STATUSES.map((status) => (
          <li key={status}>
            <Link
              href={{ pathname: "/proposals", query: { status } }}
              aria-current={filter === status ? "page" : undefined}
              className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-primary-soft"
            >
              <span>{PROPOSAL_STATUS_LABEL[status]}</span>
              <span className="font-semibold tabular-nums">{counts[status]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <form action="/proposals">
        <FilterBar>
          <ToolbarField label="Status" htmlFor="status" className="sm:w-52">
            <NativeSelect id="status" name="status" defaultValue={filter}>
              {FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : PROPOSAL_STATUS_LABEL[value]}
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
        getRowKey={({ proposal }) => proposal.id}
        caption="Proposals"
        empty={
          <EmptyState
            icon={FileSignature}
            action={
              <Button asChild>
                <Link href="/proposals/new">New proposal</Link>
              </Button>
            }
          >
            {filter === "all"
              ? "No proposals yet. Write one for a lead after the discovery call, or for a client taking on more work."
              : `No ${PROPOSAL_STATUS_LABEL[filter].toLowerCase()} proposals.`}
          </EmptyState>
        }
      />
    </>
  );
}
