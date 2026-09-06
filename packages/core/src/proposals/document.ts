import { escapeHtml } from "@launchos/channels";
import { DOCUMENT_MARGIN, renderDocumentHtml, type RenderPdfInput } from "@launchos/channels/pdf";
import type { ProposalLineKind } from "@launchos/db/schema";
import { describePricing, formatPence, lineTotalPence, type ProposalTotals } from "./pricing.js";
import { formatValidUntil, signatureSvgMarkup, type ProposalAcceptanceRow, type ProposalLineRow, type ProposalRow } from "./shared.js";

/**
 * A proposal on LaunchFlow's headed paper.
 *
 * The chrome — letterhead, type scale, footer with page numbers — belongs to
 * `packages/channels/src/pdf/document.ts` and is shared with every other
 * document kind, so this file supplies a body and nothing else. That is what
 * makes "everything the client keeps looks like the same company" true rather
 * than intended.
 *
 * **Everything dynamic is escaped here.** `renderDocumentHtml`'s `bodyHtml` is
 * trusted-caller-only, and a proposal is the least trustworthy body in the
 * system: it carries a client's own typed company name, a summary an agent
 * drafted, and — on the countersigned copy — a signature drawn by a stranger
 * on a public page. Every one of those goes through `escapeHtml`; the
 * signature is the single exception and is built by `signatureSvgMarkup` from
 * path data that has already been matched against the SVG path grammar.
 */

/** How each line kind is headed in the priced schedule. */
const LINE_KIND_LABEL: Record<ProposalLineKind, string> = {
  setup: "One-off, to start",
  monthly: "Every month",
  one_off: "One-off",
};

/** The order the schedule prints its groups in: what they pay first, first. */
const LINE_KIND_ORDER: readonly ProposalLineKind[] = ["setup", "one_off", "monthly"];

function listHtml(heading: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<h2>${escapeHtml(heading)}</h2><ul>${rows}</ul>`;
}

function paragraphsHtml(text: string | null): string {
  if (!text?.trim()) return "";
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\r?\n/g, "<br />")}</p>`)
    .join("");
}

/** One priced group: its lines, and the total of that group. */
function scheduleGroupHtml(kind: ProposalLineKind, lines: readonly ProposalLineRow[]): string {
  const rows = lines
    .map((line) => {
      const quantity = line.quantity === 1 ? "" : `<td class="numeric">${line.quantity} × ${escapeHtml(formatPence(line.unitPence))}</td>`;
      return `<tr><td>${escapeHtml(line.description)}</td>${quantity || "<td></td>"}<td class="numeric">${escapeHtml(formatPence(lineTotalPence(line)))}</td></tr>`;
    })
    .join("");
  const total = lines.reduce((sum, line) => sum + lineTotalPence(line), 0);
  const suffix = kind === "monthly" ? " a month" : "";
  return `<h2>${escapeHtml(LINE_KIND_LABEL[kind])}</h2>
    <table>
      <tbody>${rows}
        <tr class="total"><td>Total</td><td></td><td class="numeric">${escapeHtml(formatPence(total) + suffix)}</td></tr>
      </tbody>
    </table>`;
}

function scheduleHtml(lines: readonly ProposalLineRow[]): string {
  return LINE_KIND_ORDER.map((kind) => {
    const group = lines.filter((line) => line.kind === kind);
    return group.length === 0 ? "" : scheduleGroupHtml(kind, group);
  }).join("");
}

/**
 * The acceptance block, printed only on the countersigned copy.
 *
 * It is the evidence: who agreed, from where, at what moment, and the mark
 * they drew. Written into the document rather than only into the database
 * because the copy in the client's inbox has to say the same thing as our row.
 */
function acceptanceHtml(acceptance: ProposalAcceptanceRow): string {
  const when = acceptance.acceptedAt.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    dateStyle: "long",
    timeStyle: "short",
  });
  const signature = acceptance.signatureSvg
    ? `<div style="width:60mm;height:20mm;margin:6pt 0;">${signatureSvgMarkup(acceptance.signatureSvg)}</div>`
    : "";
  return `<h2>Accepted</h2>
    ${signature}
    <table>
      <tbody>
        <tr><td>Name</td><td>${escapeHtml(acceptance.acceptedName)}</td></tr>
        <tr><td>Email</td><td>${escapeHtml(acceptance.acceptedEmail)}</td></tr>
        <tr><td>Accepted</td><td>${escapeHtml(when)} (UK time)</td></tr>
        ${acceptance.ip ? `<tr><td>From</td><td>${escapeHtml(acceptance.ip)}</td></tr>` : ""}
      </tbody>
    </table>`;
}

export interface ProposalDocumentInput {
  proposal: ProposalRow;
  lines: readonly ProposalLineRow[];
  totals: ProposalTotals;
  /** The name printed under "Prepared for" — the client's or the lead's. */
  recipientName: string;
  /** Present only on the countersigned copy. */
  acceptance?: ProposalAcceptanceRow | undefined;
}

/** The document's title, at the top of page one and in the PDF's own metadata. */
export function proposalDocumentTitle(proposal: Pick<ProposalRow, "title">, accepted: boolean): string {
  return accepted ? `${proposal.title} — accepted` : proposal.title;
}

/** The HTML for a proposal, ready for `renderPdf`. */
export function proposalDocumentHtml(input: ProposalDocumentInput): string {
  const { proposal, lines, totals, recipientName, acceptance } = input;
  const meta = [
    { label: "Reference", value: proposal.reference },
    { label: "Prepared for", value: recipientName },
    ...(proposal.validUntil && !acceptance ? [{ label: "Valid until", value: formatValidUntil(proposal.validUntil) }] : []),
  ];

  const bodyHtml = [
    paragraphsHtml(proposal.summary),
    listHtml("What you get", proposal.scope.deliverables),
    scheduleHtml(lines),
    `<p><strong>${escapeHtml(describePricing(totals))}</strong></p>`,
    proposal.scope.timeline ? `<h2>Timing</h2>${paragraphsHtml(proposal.scope.timeline)}` : "",
    listHtml("Not included", proposal.scope.outOfScope),
    proposal.terms ? `<h2>Terms</h2>${paragraphsHtml(proposal.terms)}` : "",
    acceptance ? acceptanceHtml(acceptance) : "",
  ].join("\n");

  return renderDocumentHtml({
    title: proposalDocumentTitle(proposal, Boolean(acceptance)),
    subtitle: `Prepared for ${recipientName}`,
    meta,
    bodyHtml,
    ...(proposal.pricing.vatNote ? { closingNote: proposal.pricing.vatNote } : {}),
  });
}

/** The render request for a proposal: the HTML, A4, and the reference in the footer. */
export function proposalRenderInput(input: ProposalDocumentInput): RenderPdfInput {
  return {
    html: proposalDocumentHtml(input),
    format: "A4",
    margin: DOCUMENT_MARGIN,
    footerReference: input.proposal.reference,
  };
}
