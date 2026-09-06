import { renderPdf, type RenderPdfInput } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { signedDocumentUrl } from "../documents/document-link.js";
import { storeDocument, type DocumentKind, type DocumentRow } from "../documents/store-document.js";
import { emit } from "../events/emit.js";
import { markLeadContacted } from "../leads/leads.js";
import { getProposalDetail, type ProposalDetail } from "./crud.js";
import { proposalDocumentTitle, proposalRenderInput } from "./document.js";
import { isPricedAtNothing } from "./pricing.js";
import { queueProposalNotice, sentBody } from "./notices.js";
import {
  ActorKindSchema,
  PROPOSAL_SUBJECT_TYPE,
  PROPOSAL_TARGET_TYPE,
  ProposalRefused,
  hasExpired,
  proposalPublicUrl,
  requireProposal,
  type ProposalRow,
} from "./shared.js";

/**
 * Sending a proposal: render it, keep it, and tell the client where it is.
 *
 * **The renderer is a dependency.** `apps/worker` is the only process with
 * Chromium in its image — `playwright` is its dependency and not the web
 * app's — so a `sendProposal` that reached for a browser from a Next.js route
 * handler would work on a laptop and fail on Coolify. Passing it in makes the
 * requirement visible at every call site: the worker hands over the real
 * `renderPdf`, and tests get the mock for free because `pdfRendererKind`
 * already returns `mock` under `NODE_ENV=test`.
 *
 * The render and the file write happen **before** the transaction, for the
 * same reason `bookMeeting` creates its Zoom meeting before one: a browser
 * call and a disk write must not hold a database lock. A send that then fails
 * leaves an orphan document, which costs a few kilobytes and no correctness.
 */

/** How the sent PDF is filed, and how the countersigned copy is filed. */
export const PROPOSAL_DOCUMENT_KIND: DocumentKind = "proposal";
export const PROPOSAL_SIGNED_DOCUMENT_KIND: DocumentKind = "proposal_signed";

/** What `sendProposal` needs from the outside world. */
export interface ProposalDeps {
  /**
   * Renders HTML to PDF bytes. Defaults to the shared engine, which is
   * Chromium outside tests — so a caller in a process without a browser must
   * pass one, and a caller in the worker need not.
   */
  render?: ((input: RenderPdfInput) => Promise<Uint8Array<ArrayBuffer>>) | undefined;
}

const renderer = (deps: ProposalDeps | undefined) => deps?.render ?? ((input: RenderPdfInput) => renderPdf(input));

export const SendProposalInput = z.object({
  proposalId: z.string().uuid(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type SendProposalInput = z.input<typeof SendProposalInput>;

export interface SendProposalResult {
  proposal: ProposalRow;
  document: DocumentRow;
  /** The signed, expiring link to the PDF that went in the email. */
  documentUrl: string;
  /** The public page the client reads and accepts on. */
  proposalUrl: string;
  notice: typeof schema.messages.$inferSelect;
}

/**
 * Renders a proposal and stores it as a document.
 *
 * Used by `sendProposal` for the copy the client is sent, and by the follow-on
 * job for the countersigned copy — the two differ only in `kind` and in
 * whether an acceptance block is printed, so they share this.
 */
export async function renderProposalDocument(
  db: Db,
  organisationId: string,
  detail: ProposalDetail,
  options: { kind: DocumentKind; actorKind?: z.infer<typeof ActorKindSchema>; actorId?: string | undefined },
  deps?: ProposalDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentRow> {
  const accepted = options.kind === PROPOSAL_SIGNED_DOCUMENT_KIND;
  const bytes = await renderer(deps)(proposalRenderInput({
    proposal: detail.proposal,
    lines: detail.lines,
    totals: detail.totals,
    recipientName: detail.recipient?.name ?? detail.proposal.title,
    ...(accepted && detail.acceptance ? { acceptance: detail.acceptance } : {}),
  }));
  return storeDocument(db, organisationId, {
    kind: options.kind,
    title: proposalDocumentTitle(detail.proposal, accepted),
    reference: detail.proposal.reference,
    clientId: detail.proposal.clientId,
    subjectType: PROPOSAL_SUBJECT_TYPE,
    subjectId: detail.proposal.id,
    bytes,
    actorKind: options.actorKind ?? "user",
    ...(options.actorId ? { actorId: options.actorId } : {}),
  }, env);
}

/**
 * Sends a draft: renders the PDF, keeps it, moves the proposal to `sent` and
 * queues the client's email.
 *
 * Four refusals, all of them things a person would want to know before a
 * client does: no draft (`not_sendable`), nobody to write to (`no_recipient`),
 * nothing priced (`no_price`) and a validity date already gone (`expired`).
 *
 * The email carries the **signed document link**, not the PDF as an
 * attachment. `EmailAdapter.send` has no attachment parameter today, and the
 * link is the access-controlled path P3a built for exactly this: it expires,
 * it cannot be moved to another document, and a forwarded copy stops working.
 * `metadata.documentId` is stamped on the message so the sender can attach the
 * bytes the day the adapter grows the ability.
 */
export async function sendProposal(
  db: Db,
  organisationId: string,
  input: SendProposalInput,
  deps?: ProposalDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendProposalResult> {
  const v = SendProposalInput.parse(input);
  const now = v.now ?? new Date();
  const before = await requireProposal(db, organisationId, v.proposalId);
  if (before.status !== "draft") {
    throw new ProposalRefused("not_sendable", `Proposal ${before.reference} has already been sent.`);
  }
  const detail = (await getProposalDetail(db, organisationId, before.id))!;
  if (!detail.recipient) {
    throw new ProposalRefused("no_recipient", "There is no email address on this lead or client to send the proposal to.");
  }
  if (isPricedAtNothing(detail.totals)) {
    throw new ProposalRefused("no_price", `Proposal ${before.reference} has nothing priced on it yet.`);
  }
  if (hasExpired(before, now)) {
    throw new ProposalRefused("expired", `Proposal ${before.reference} is dated to expire already — move the valid-until date first.`);
  }

  const document = await renderProposalDocument(
    db, organisationId, detail,
    { kind: PROPOSAL_DOCUMENT_KIND, actorKind: v.actorKind, actorId: v.actorId },
    deps, env,
  );
  const documentUrl = signedDocumentUrl({ organisationId, documentId: document.id }, env);
  const proposalUrl = proposalPublicUrl(before, env);

  const sent = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.proposals)
      .set({ status: "sent", sentAt: now, documentId: document.id, updatedAt: now })
      .where(and(eq(schema.proposals.id, before.id), eq(schema.proposals.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "proposal.sent",
      targetType: PROPOSAL_TARGET_TYPE, targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      ...(after!.clientId ? { clientId: after!.clientId } : {}),
      actorKind: v.actorKind, actorId: v.actorId, kind: "proposal.sent",
      title: `Proposal ${after!.reference} sent to ${detail.recipient!.email}`,
      link: `/proposals/${after!.id}`,
    });
    if (after!.leadId) await markLeadContacted(tx, organisationId, after!.leadId, { actorKind: v.actorKind, actorId: v.actorId });
    const notice = await queueProposalNotice(tx, organisationId, {
      proposal: after!,
      notice: "sent",
      to: detail.recipient!.email,
      subject: `Your proposal from LaunchFlow: ${after!.title}`,
      body: sentBody(after!, detail.totals, detail.recipient!.name, documentUrl, env),
      links: { proposalUrl, documentUrl, documentId: document.id },
      actorKind: v.actorKind, actorId: v.actorId,
    });
    return { after: after!, notice };
  });

  await emit({ name: "message.queued", organisationId, messageId: sent.notice.id });
  return { proposal: sent.after, document, documentUrl, proposalUrl, notice: sent.notice };
}
