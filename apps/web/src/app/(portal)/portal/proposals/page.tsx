import { formatPence, listProposals, type ProposalRow, proposalPublicUrl, signedDocumentUrl } from "@launchos/core";
import { schema } from "@launchos/db";
import type { ProposalStatus } from "@launchos/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { FileSignature } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/** Newest first; a client who has been here for years does not need all of them at once. */
const LIST_LIMIT = 100;

/**
 * The client's own words for where a proposal stands. `draft` is not in the
 * map because a draft never reaches this page — it has not been sent, so as
 * far as the client is concerned it does not exist.
 */
const STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Being written",
  sent: "Waiting for you",
  viewed: "Waiting for you",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

const STATUS_TONE: Record<ProposalStatus, StatusTone> = {
  draft: "neutral",
  sent: "warn",
  viewed: "warn",
  accepted: "success",
  declined: "neutral",
  expired: "neutral",
};

type Row = {
  proposal: ProposalRow;
  /** The countersigned PDF's private link, when they have accepted. */
  signedUrl: string | null;
  agreedAt: Date | null;
};

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "title",
    header: "Proposal",
    primary: true,
    cell: ({ proposal }) => (
      <>
        {proposal.title}
        <span className="block font-mono text-meta font-normal text-muted-foreground">{proposal.reference}</span>
      </>
    ),
  },
  {
    key: "status",
    header: "Status",
    status: true,
    cell: ({ proposal }) => <StatusBadge value={proposal.status} label={STATUS_LABEL[proposal.status]} tone={STATUS_TONE[proposal.status]} />,
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
  {
    key: "when",
    header: "Agreed",
    className: "whitespace-nowrap",
    cell: ({ agreedAt, proposal }) => (agreedAt ? formatDate(agreedAt) : proposal.sentAt ? `Sent ${formatDate(proposal.sentAt)}` : "—"),
  },
  {
    key: "open",
    header: "Open",
    action: true,
    cell: ({ proposal, signedUrl }) =>
      signedUrl ? (
        <Button asChild variant="secondary" size="sm">
          <a href={signedUrl}>Signed copy</a>
        </Button>
      ) : proposal.status === "sent" || proposal.status === "viewed" ? (
        <Button asChild size="sm">
          <a href={proposalPublicUrl(proposal)}>Read and decide</a>
        </Button>
      ) : proposal.status === "accepted" ? (
        // Accepted, but the countersigned PDF has not been rendered yet: the
        // worker does that a moment after acceptance, and a bare dash where a
        // copy is expected reads as "you are not getting one".
        <span className="text-sm text-muted-foreground">Signed copy on its way</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

export default async function PortalProposalsPage() {
  const session = await requireClient();
  const db = getDb();

  const proposals = (await listProposals(db, session.organisationId, { clientId: session.clientId, limit: LIST_LIMIT }))
    // A draft is ours, not theirs: it has not been sent to anybody.
    .filter((proposal) => proposal.status !== "draft");

  // The countersigned copies, in one query rather than one per row.
  const ids = proposals.map((proposal) => proposal.id);
  const acceptances =
    ids.length === 0
      ? []
      : await db
          .select({
            proposalId: schema.proposalAcceptances.proposalId,
            documentId: schema.proposalAcceptances.documentId,
            acceptedAt: schema.proposalAcceptances.acceptedAt,
          })
          .from(schema.proposalAcceptances)
          .where(
            and(
              eq(schema.proposalAcceptances.organisationId, session.organisationId),
              inArray(schema.proposalAcceptances.proposalId, ids),
            ),
          );
  const acceptedById = new Map(acceptances.map((row) => [row.proposalId, row]));

  const rows: Row[] = proposals.map((proposal) => {
    const accepted = acceptedById.get(proposal.id);
    return {
      proposal,
      // The document's own signed, expiring link — the same one the email
      // carries, so the copy they open here is the copy they were sent. It is
      // minted per render, so a page left open overnight still opens the file
      // in the morning.
      signedUrl:
        accepted?.documentId
          ? signedDocumentUrl({ organisationId: session.organisationId, documentId: accepted.documentId })
          : null,
      agreedAt: accepted?.acceptedAt ?? null,
    };
  });

  return (
    <>
      <PageHeader
        title="Proposals"
        description="What we quoted, what you agreed to, and a signed copy of each one."
        category="delivery"
      />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={({ proposal }) => proposal.id}
        caption="Your proposals"
        empty={
          <EmptyState icon={FileSignature}>
            Nothing here yet. When we quote for a piece of work, the proposal and your signed copy of it live on this page.
          </EmptyState>
        }
      />

      {rows.length === LIST_LIMIT ? (
        <p className="mt-3 text-meta text-muted-foreground">
          Showing the {LIST_LIMIT} most recent proposals. Ask us if you need an older one.
        </p>
      ) : null}
    </>
  );
}
