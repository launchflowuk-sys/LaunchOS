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
 *   on the request while it finds out. The wordmark is therefore the real logo
 *   *embedded* — see `brand-logo.ts`, whose bytes travel with the code — and
 *   never a URL. It was type-set for the same reason before the bytes were
 *   carried; a client asked why their invoice had no logo on it, which is a
 *   fair question about a document that is supposed to be headed paper. Same
 *   reason there is no web font: the container has DejaVu and Liberation, the
 *   desktop has Segoe UI or Helvetica, and a document must not depend on
 *   Google's CDN.
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
import { BRAND_LOGO_DATA_URI, BRAND_LOGO_HEIGHT_PT, BRAND_LOGO_WIDTH_PT } from "./brand-logo.js";
import type { PdfMargin } from "./types.js";

/**
 * One sans for everything, the same as the emails.
 *
 * This was a serif, on the reasoning that a document is read as a document
 * rather than as interface. That is a real argument and it lost to a better
 * one: a client who reads a support reply on Monday and opens the invoice on
 * Tuesday should see one company, and a serif invoice behind a sans email is
 * two. Shoji's call, and the brand is his.
 *
 * Written widest-net-first so it resolves everywhere we render: Liberation and
 * DejaVu in the Alpine worker image, Segoe UI or Helvetica on a desktop, the
 * generic `sans-serif` if a future base image ships neither. No web font — a
 * document must not depend on Google's CDN, for the same reason nothing else
 * here is fetched.
 */
const BODY_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Liberation Sans', 'DejaVu Sans', Roboto, Helvetica, Arial, sans-serif";
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
         its own margin option so the two can never drift apart, which
         pdf.test.ts asserts. */
      @page { size: A4; margin: ${DOCUMENT_MARGIN.top} ${DOCUMENT_MARGIN.right} ${DOCUMENT_MARGIN.bottom} ${DOCUMENT_MARGIN.left}; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ${BODY_FONT};
        font-size: 10pt;
        line-height: 1.55;
        color: ${BRAND.ink};
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      /* The masthead: the logo navy carrying the wordmark reversed out of it,
         with the document's own reference on the right. This is where the brand
         lives on paper.
         Inset rather than bled to the paper edge, for two reasons. Most
         printers physically cannot print to the edge, so a bleed is clipped or
         ringed in white either way. And a full-bleed band needs a zero @page
         margin, which would then disagree with the margin the renderer hands
         Chromium — the two must match, and pdf.test.ts is there to keep them
         matching.
         The page itself stays white: a tinted ground is a screen idea, and on
         paper it is a page flooded with ink for no reader's benefit. */
      .masthead {
        background: ${BRAND.navy};
        color: #FFFFFF;
        border-radius: 8px;
        margin: 0 0 0;
        padding: 9mm 10mm 8mm;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18pt;
      }
      /* The logo's lettering is navy, so on the navy masthead it goes on a
         white chip — the same move BrandTile makes on the admin rail, for the
         same reason. A reversed export would be a second asset to keep in step
         with the first. */
      .brand-chip {
        background: #FFFFFF;
        border-radius: 6px;
        padding: 6pt 9pt;
        display: inline-block;
        line-height: 0;
      }
      .brand-chip img { width: ${BRAND_LOGO_WIDTH_PT}pt; height: ${BRAND_LOGO_HEIGHT_PT}pt; display: block; }
      .brand-line { margin-top: 6pt; font-size: 7.5pt; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.62); }
      /* The billed-to block. The address used to inherit the body paragraph's
         9pt bottom margin per line, so a four-line address opened a gap the
         size of a paragraph between the name and the town. It is one block of
         text about one company and should read as one. */
      .bill-to p { margin: 0 0 1pt; }
      .bill-to { margin: 0 0 4pt; }

      /* How to pay. A two-column list rather than a sentence, because these are
         digits somebody is going to retype into their banking app. */
      .pay-by { width: auto; margin: 0 0 10pt; font-size: 9.5pt; }
      .pay-by td { border-bottom: none; padding: 2pt 0; }
      .pay-by .pay-label { color: ${BRAND.muted}; padding-right: 16pt; white-space: nowrap; }
      .footer-note { margin-top: 14pt; font-size: 9pt; }

      /* The swoosh cyan, the one decorative stroke — the same rule the email
         shell opens with, so the two are recognisably one family. */
      .rule { height: 3px; background: ${BRAND.cyan}; border-radius: 2px; margin: 3pt 0 16pt; }

      .meta { margin: 0; font-size: 8.5pt; color: rgba(255,255,255,0.62); text-align: right; min-width: 46mm; }
      .meta-row { display: flex; justify-content: flex-end; gap: 8pt; }
      .meta dt { font-weight: 500; color: rgba(255,255,255,0.62); }
      .meta dd { margin: 0; color: #FFFFFF; font-weight: 600; }

      h1 { font-size: 17pt; line-height: 1.25; font-weight: 650; letter-spacing: -0.015em; color: ${BRAND.navy}; margin: 0 0 3pt; }
      .subtitle { font-size: 10.5pt; color: ${BRAND.muted}; margin: 0 0 18pt; }
      h2 { font-size: 8pt; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: ${BRAND.muted}; margin: 20pt 0 7pt; }
      /* Never orphan a heading at the foot of a page, and never split a priced
         row across two — a client reading half a total is a phone call. */
      h2, h3 { break-after: avoid; }
      table, tr, li { break-inside: avoid; }
      p { margin: 0 0 9pt; }
      ul, ol { margin: 0 0 9pt; padding-left: 16pt; }
      li { margin-bottom: 3pt; }

      table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 9.5pt; margin: 0 0 12pt; }
      /* Separated cells rather than collapsed: a collapsed table will not
         honour the radius on the total band, and its cells leave hairlines
         between them that break the fill into three boxes. Spacing is zero, so
         nothing else about the tables changes. */
      th { text-align: left; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${BRAND.muted}; border-bottom: 1.5px solid ${BRAND.navy}; padding: 0 0 5pt; }
      td { border-bottom: 1px solid ${BRAND.hairline}; padding: 7pt 0; vertical-align: top; }
      .numeric { text-align: right; white-space: nowrap; }
      /* A second line inside a cell — a milestone's detail under its title. In
         the chrome rather than inline in one document's body, so the third
         document kind that needs a quieter line uses this one. */
      .muted { color: ${BRAND.muted}; }

      /* Sub-totals lead up to the figure; the figure itself is the one thing on
         the page a client looks for, so it stops being bold text on a rule and
         becomes a band of the brand navy with the amount set large. */
      .subtotal td { border-bottom: none; padding: 3pt 0; color: ${BRAND.muted}; }
      /* The cell stays an ordinary table cell so the column algorithm is left
         alone; the band inside it does the layout. Flexing the cell itself
         takes it out of that algorithm and the table overflows the page.
         NB: no backticks anywhere in this block — it is a template literal and
         one closes it. */
      .total td { border: none; padding: 6pt 0 0; background: transparent; }
      .band {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12pt;
        background: ${BRAND.navy};
        color: #FFFFFF;
        border-radius: 6px;
        padding: 9pt 11pt;
      }
      .band > span:first-child { font-size: 9.5pt; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
      .band .figure { font-size: 13pt; font-weight: 700; white-space: nowrap; }

      .note { margin-top: 18pt; padding-top: 10pt; border-top: 1px solid ${BRAND.hairline}; font-size: 8pt; line-height: 1.6; color: ${BRAND.muted}; }
    </style>
  </head>
  <body>
    <div class="masthead">
      <div>
        <span class="brand-chip"><img src="${BRAND_LOGO_DATA_URI}" alt="LaunchFlow" /></span>
        <div class="brand-line">Powered by LaunchFlow</div>
      </div>
      ${input.meta && input.meta.length > 0 ? metaHtml(input.meta) : ""}
    </div>
    <div class="rule"></div>
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
