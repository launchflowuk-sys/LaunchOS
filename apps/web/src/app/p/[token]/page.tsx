import {
  describePricing,
  formatValidUntil,
  getPublicProposal,
  hasExpired,
  PROPOSAL_LIVE_STATUSES,
  recordProposalView,
} from "@launchos/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InlineAlert } from "@/components/inline-alert";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { PublicShell } from "../../(marketing)/site/_components/public-shell";
import { DecisionPanel } from "./decision-panel";
import { ProposalBody } from "./proposal-body";

/**
 * A proposal, read by whoever holds its link.
 *
 * Public and unauthenticated by position, like `/book` and `/signup`: this
 * route sits outside the `(admin)` and `(portal)` groups, so neither shell's
 * `require*` runs here, and `/p` is passed through by the proxy so it answers
 * on the marketing host and the app host alike — the client bookmarks this
 * link and forwards it to a business partner, and both hosts have to work.
 *
 * **The token is the only key.** Every core call below takes it rather than an
 * id, so there is nothing on this page a caller could guess. A link that
 * matches nothing and a proposal that has not been sent both get the same
 * plain 404 — no page, no explanation, nothing that says which.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your proposal — LaunchFlow",
  description: "Read your proposal from LaunchFlow and accept or decline it.",
  // Never indexed and never followed: the URL is the authorisation.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PublicProposalPage({ params }: PageProps<"/p/[token]">) {
  const { token } = await params;
  const detail = await getPublicProposal(getDb(), token);
  // A draft has been written but not sent, so as far as the world is
  // concerned it does not exist yet.
  if (!detail || detail.proposal.status === "draft") notFound();

  // Records that they opened it, once, and rings the owner's bell on that one
  // open only. Idempotent in the UPDATE itself, so two page loads arriving
  // together do not ring it twice.
  await recordProposalView(getDb(), detail.proposal.organisationId, { token });

  const { proposal, acceptance, recipient } = detail;
  const expired = hasExpired(proposal, new Date());
  const live = PROPOSAL_LIVE_STATUSES.includes(proposal.status) && !expired;
  const description = describePricing(detail.totals);

  return (
    <PublicShell
      title={proposal.title}
      description={
        proposal.validUntil && live
          ? `Proposal ${proposal.reference}. It stands until ${formatValidUntil(proposal.validUntil)}.`
          : `Proposal ${proposal.reference}.`
      }
    >
      <div className="mx-auto grid max-w-3xl gap-10">
        {proposal.status === "accepted" ? (
          <InlineAlert tone="success" title="You accepted this proposal">
            {acceptance
              ? `Signed by ${acceptance.acceptedName} on ${formatDate(acceptance.acceptedAt)}. A countersigned copy is on its way to ${acceptance.acceptedEmail}.`
              : "Thank you — we have it. A countersigned copy is on its way to you."}
          </InlineAlert>
        ) : null}

        {proposal.status === "declined" ? (
          <InlineAlert tone="info" title="You declined this proposal">
            Thanks for letting us know. If anything changes, reply to our email and we will pick it back up.
          </InlineAlert>
        ) : null}

        {live || proposal.status === "accepted" || proposal.status === "declined" ? null : (
          <InlineAlert tone="warning" title="This proposal is no longer open">
            {proposal.validUntil
              ? `It stood until ${formatValidUntil(proposal.validUntil)}. Reply to our email and we will put a fresh one together — the prices are usually the same.`
              : "Reply to our email and we will put a fresh one together."}
          </InlineAlert>
        )}

        <ProposalBody detail={detail} description={description} />

        {live ? (
          <DecisionPanel
            token={proposal.publicToken}
            defaults={{ name: recipient?.name ?? "", email: recipient?.email ?? "" }}
            termsGiven={Boolean(proposal.terms?.trim())}
          />
        ) : null}

        <p className="text-center text-sm" style={{ color: "var(--mute)" }}>
          Questions about any of this? Reply to the email this link came in and we will answer.
        </p>
      </div>
    </PublicShell>
  );
}
