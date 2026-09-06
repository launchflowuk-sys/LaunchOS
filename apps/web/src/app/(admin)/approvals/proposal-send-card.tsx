import {
  describePricing,
  formatPence,
  getProposalDetail,
  proposalDocumentHtml,
  proposalDocumentTitle,
  proposalPublicUrl,
  ProposalSendPayload,
} from "@launchos/core";
import type { schema } from "@launchos/db";
import { Pencil } from "lucide-react";
import Link from "next/link";
import { DocumentPreview } from "@/components/document-preview";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { ProposalTotals } from "@/components/proposal-totals";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * A drafted proposal asking to be sent — the Proposal Drafter's one outward
 * action, and the biggest single thing an agent can do in this business.
 *
 * What the card shows is **the document itself**, rendered from the proposal
 * row by the same function the worker prints, not a description of it written
 * by the model. The payload names the proposal; everything read from it comes
 * out of our own database. That is the rule the content and lead-reply cards
 * follow, and it is what makes "read what will actually go out" true rather
 * than intended.
 *
 * Editing before sending is a link rather than a textarea, and that is the
 * honest shape for this one: a proposal is a title, a scope, a schedule of
 * priced lines and a payment shape, not a paragraph — and its own screen is
 * where all of that is edited, with the running totals beside it. The proposal
 * stays a draft while this card is pending, so it is editable right up to the
 * moment Approve queues the send. Because it is, the card also says when the
 * price has moved since the request was raised: approving after an edit sends
 * the new figure, and the person deciding should know that before they do.
 */
export async function ProposalSendRequest({ approval }: { approval: typeof schema.approvals.$inferSelect }) {
  const payload = ProposalSendPayload.safeParse(approval.payload);
  if (!payload.success) {
    return (
      <InlineAlert tone="danger" title="This request cannot be shown">
        The stored request does not match what this screen expects, so approve nothing until it has been checked from the
        Proposals screen.
      </InlineAlert>
    );
  }

  const session = await requireAdmin();
  const detail = await getProposalDetail(getDb(), session.organisationId, payload.data.proposalId);
  if (!detail) {
    return (
      <InlineAlert tone="danger" title="That proposal is gone">
        The proposal this request points at no longer exists. Reject the request.
      </InlineAlert>
    );
  }

  const { proposal, lines, totals, recipient } = detail;
  const alreadySent = proposal.status !== "draft";
  const priceMoved = totals.firstYearPence !== payload.data.firstYearPence;

  return (
    <>
      <InlineAlert tone={alreadySent || !recipient ? "danger" : "warning"} title="What approving does">
        {alreadySent ? (
          <>Proposal {proposal.reference} has already been sent, so approving this would do nothing. Reject it.</>
        ) : recipient ? (
          <>
            Emails proposal {proposal.reference} to {recipient.name} at {recipient.email} with a private link to the PDF
            and their own acceptance page, and freezes the wording and the price. Rejecting sends nothing and leaves it a
            draft. Edit it first if you like — what is on this screen is what goes.
          </>
        ) : (
          <>
            There is no email address on the lead or client this proposal is for, so it cannot be sent. Add one from
            their page, or reject this.
          </>
        )}
      </InlineAlert>

      {priceMoved ? (
        <InlineAlert tone="warning" title="The price has changed since this was raised">
          It was {formatPence(payload.data.firstYearPence)} over the first year when the request was made and is{" "}
          {formatPence(totals.firstYearPence)} now. Approving sends the figures below.
        </InlineAlert>
      ) : null}

      <ProposalTotals totals={totals} description={describePricing(totals)} vatNote={proposal.pricing.vatNote} />

      <KeyValue
        columns={2}
        items={[
          { label: "Reference", value: proposal.reference },
          { label: "Title", value: proposal.title },
          { label: "To", value: recipient ? `${recipient.name} · ${recipient.email}` : "Nobody — no email address on file" },
          { label: "Valid until", value: proposal.validUntil ?? "No end date" },
          { label: "Priced lines", value: `${lines.length}` },
          { label: "Their link", value: <span className="font-mono text-meta break-all">{proposalPublicUrl(proposal)}</span> },
        ]}
      />

      <DocumentPreview
        html={proposalDocumentHtml({ proposal, lines, totals, recipientName: recipient?.name ?? payload.data.recipientName })}
        title={proposalDocumentTitle(proposal, false)}
      />

      <div>
        <Button asChild variant="secondary">
          <Link href={`/proposals/${proposal.id}`}>
            <Pencil aria-hidden /> Open and edit before sending
          </Link>
        </Button>
      </div>
    </>
  );
}
