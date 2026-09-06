/**
 * The one sheet of headed paper every LaunchFlow document is printed on.
 *
 * It sits beside `email/template.ts` and borrows its `BRAND` palette and its
 * escaping wholesale, because they are the same design system seen twice: a
 * client who reads a support reply on Monday and opens a proposal on Tuesday
 * must see one company. What differs is the medium, and three rules follow
 * from that rather than from taste:
 *
 * - **Nothing is fetched.** The email shell loads the wordmark from an
 *   absolute URL; a document may not. A PDF is kept for years and re-rendered
 *   for a countersigned copy, so a remote asset means the same document is a
 *   different file depending on whether the app was up — and Chromium stalls
 *   on the request while it finds out. The wordmark is therefore *set*, in
 *   type, from the same two colours as the logo. Same reason there is no web
 *   font: the container has DejaVu and Liberation, the desktop has Segoe UI or
 *   Helvetica, and a document must not depend on Google's CDN.
 * - **Real CSS.** No mail client is involved, so this is a stylesheet and a
 *   grid rather than nested tables, and `@page` sets the margins Chromium
 *   prints inside.
 * - **Page numbers come from Chromium, not from here.** `footerTemplate` is
 *   the only place a browser will count pages, so the footer is built by
 *   `documentFooterTemplate` below and handed to the renderer, not written
 *   into the body.
 *
 * Everything that reaches this page from a person, a client record or a model
 * goes through `escapeHtml` — a proposal carries a client's own typed company
 * name and a summary an agent drafted, and neither may put a tag in a document
 * we then hand back to them. `bodyHtml` is the one deliberate exception and is
 * trusted-caller-only, exactly as in the email shell.
 */
import { BRAND, escapeHtml } from "../email/template.js";
import type { PdfMargin } from "./types.js";

/**
 * A serif for the body.
 *
 * The emails are set in the interface's own sans because they are read in an
 * inbox beside other interface text. A document is read as a document, and the
 * stack is written widest-net-first so it resolves on all three places we
 * render: `Liberation Serif`/`DejaVu Serif` in the Alpine worker image,
 * Georgia on a Windows or Mac desktop, and the generic `serif` if a future
 * base image ships neither.
 */
const BODY_FONT = "Georgia, 'Liberation Serif', 'DejaVu Serif', 'Times New Roman', serif";
/** The wordmark, the headings and the footer: the interface's voice. */
const UI_FONT = "'Segoe UI', 'Liberation Sans', 'DejaVu Sans', Helvetica, Arial, sans-serif";

/** 18mm all round, with room at the foot for the printed footer. */
export const DOCUMENT_MARGIN: Required<PdfMargin> = {
  top: "16mm",
  right: "16mm",
  bottom: "18mm",
  left: "16mm",
};

export interface DocumentMetaRow {
  /** "Prepared for", "Reference", "Valid until". */
  label: string;
  value: string;
}

export interface DocumentHtmlInput {
  /** The `<h1>`, and the PDF's window title. Escaped. */
  title: string;
  /** A line under the title: "Website and care plan for Acme Ltd". Escaped. */
  subtitle?: string;
  /** The reference block on the right of the letterhead. Escaped, each row. */
  meta?: readonly DocumentMetaRow[];
  /**
   * Trusted HTML for the body — a table of figures, a priced schedule, a list
   * of deliverables. **Never pass a client's words or a model's output through
   * this**; that is what `paragraphs` is for. Ignored when `paragraphs` is set.
   */
  bodyHtml?: string;
  /**
   * The body as plain text, one entry per paragraph. Escaped in full, so a
   * model's stray `<div>` reads as a `<div>` and a client's `**` stays two
   * asterisks.
   */
  paragraphs?: readonly string[];
  /** The small print under the body — terms, a VAT note. Escaped. */
  closingNote?: string;
}

/** Escaped text with newlines as `<br>`, so a typed paragraph keeps its shape. */
function paragraphHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br />")}</p>`;
}

function metaHtml(rows: readonly DocumentMetaRow[]): string {
  const cells = rows
    .map((row) => `<div class="meta-row"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
    .join("");
  return `<dl class="meta">${cells}</dl>`;
}

/**
 * One document, ready for the renderer.
 *
 * The caller supplies only its body; the letterhead, the type scale and the
 * colours are here so that adding a fourth document kind in P5 cannot quietly
 * invent a fifth look.
 */
export function renderDocumentHtml(input: DocumentHtmlInput): string {
  const paragraphs = input.paragraphs?.filter((p) => p.trim().length > 0) ?? [];
  const body = paragraphs.length > 0 ? paragraphs.map(paragraphHtml).join("\n        ") : (input.bodyHtml ?? "");

  return `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      /* Chromium prints inside these; the renderer passes the same values as
         its own margin option so the two can never drift apart. */
      @page { size: A4; margin: ${DOCUMENT_MARGIN.top} ${DOCUMENT_MARGIN.right} ${DOCUMENT_MARGIN.bottom} ${DOCUMENT_MARGIN.left}; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ${BODY_FONT};
        font-size: 10.5pt;
        line-height: 1.55;
        color: ${BRAND.ink};
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      /* The swoosh cyan, the one decorative stroke — the same rule the email
         shell opens with, so the two are recognisably one family. */
      .rule { height: 3px; background: ${BRAND.cyan}; margin: 0 0 14pt; }
      .letterhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 18pt; margin-bottom: 14pt; }
      .wordmark { font-family: ${UI_FONT}; font-size: 17pt; font-weight: 700; letter-spacing: -0.02em; color: ${BRAND.navy}; }
      .wordmark span { color: ${BRAND.blue}; }
      .wordmark small { display: block; margin-top: 3pt; font-size: 8pt; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: ${BRAND.muted}; }
      .meta { margin: 0; font-family: ${UI_FONT}; font-size: 8.5pt; color: ${BRAND.muted}; text-align: right; min-width: 46mm; }
      .meta-row { display: flex; justify-content: flex-end; gap: 8pt; }
      .meta dt { font-weight: 600; color: ${BRAND.muted}; }
      .meta dd { margin: 0; color: ${BRAND.ink}; }
      h1 { font-family: ${UI_FONT}; font-size: 18pt; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; color: ${BRAND.navy}; margin: 0 0 4pt; }
      .subtitle { font-family: ${UI_FONT}; font-size: 10.5pt; color: ${BRAND.muted}; margin: 0 0 16pt; }
      h2 { font-family: ${UI_FONT}; font-size: 12pt; font-weight: 600; color: ${BRAND.navy}; margin: 18pt 0 6pt; }
      /* Never orphan a heading at the foot of a page, and never split a priced
         row across two — a client reading half a total is a phone call. */
      h2, h3 { break-after: avoid; }
      table, tr, li { break-inside: avoid; }
      p { margin: 0 0 9pt; }
      ul, ol { margin: 0 0 9pt; padding-left: 16pt; }
      li { margin-bottom: 3pt; }
      table { width: 100%; border-collapse: collapse; font-family: ${UI_FONT}; font-size: 9.5pt; margin: 0 0 12pt; }
      th { text-align: left; font-weight: 600; color: ${BRAND.muted}; border-bottom: 1px solid ${BRAND.hairline}; padding: 6pt 0; }
      td { border-bottom: 1px solid ${BRAND.hairline}; padding: 6pt 0; vertical-align: top; }
      .numeric { text-align: right; white-space: nowrap; }
      /* A second line inside a cell — a milestone's detail under its title. In
         the chrome rather than inline in one document's body, so the third
         document kind that needs a quieter line uses this one. */
      .muted { color: ${BRAND.muted}; }
      .total td { border-bottom: none; border-top: 2px solid ${BRAND.navy}; font-weight: 700; color: ${BRAND.navy}; }
      .note { margin-top: 16pt; padding-top: 10pt; border-top: 1px solid ${BRAND.hairline}; font-family: ${UI_FONT}; font-size: 8.5pt; line-height: 1.6; color: ${BRAND.muted}; }
    </style>
  </head>
  <body>
    <div class="rule"></div>
    <div class="letterhead">
      <div class="wordmark">Launch<span>Flow</span><small>Powered by LaunchFlow</small></div>
      ${input.meta && input.meta.length > 0 ? metaHtml(input.meta) : ""}
    </div>
    <h1>${escapeHtml(input.title)}</h1>
    ${input.subtitle ? `<p class="subtitle">${escapeHtml(input.subtitle)}</p>` : ""}
    ${body}
    ${input.closingNote ? `<div class="note">${escapeHtml(input.closingNote)}</div>` : ""}
  </body>
</html>
`;
}

/**
 * The printed footer: the reference on the left, "Page 1 of 3" on the right.
 *
 * Chromium renders header and footer templates in a separate document with no
 * access to the page's stylesheet and a default font size of zero, which is
 * why every value here is inline and `font-size` is stated. `pageNumber` and
 * `totalPages` are the two class names it substitutes; misspell either and the
 * footer silently prints nothing, which is what `document.test.ts` guards.
 */
export function documentFooterTemplate(reference?: string): string {
  const left = reference ? escapeHtml(reference) : "";
  return `<div style="width:100%;margin:0 12mm;font-family:${UI_FONT};font-size:7pt;color:${BRAND.muted};display:flex;justify-content:space-between;">
  <span>${left}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

/** Chromium insists on a header template when footers are on; this one is blank. */
export const EMPTY_HEADER_TEMPLATE = "<div></div>";
