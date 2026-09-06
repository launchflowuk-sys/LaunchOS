import { escapeHtml } from "@launchos/channels";

/**
 * The small slice of Markdown our own report generators emit, turned into
 * document HTML.
 *
 * **Why parse at all.** `client_reports.summary_md` is the record of what a
 * month said, and `publishClientReport` is what freezes it. Rendering the PDF
 * from anything other than that stored text would mean the document and the
 * row could disagree about the same month — which is exactly the fork the
 * monthly report was told not to build. So the document is that text, printed.
 *
 * **Why not a Markdown library.** The input is not user Markdown: it is
 * produced by `renderSummary` in this folder and by `content/report.ts`, and
 * between them they emit five constructs — `#`, `##`, `- `, `[text](url)` and
 * paragraphs. A general parser would bring a dependency, a much larger attack
 * surface and its own opinions about raw HTML, to read text we wrote. This
 * escapes first and matches second, so nothing that arrives can produce a tag
 * that was not built here, whatever a future generator (or a model writing a
 * summary) puts in the string.
 *
 * The `#` heading is dropped on purpose: the document already prints its own
 * title in the letterhead, and two headings would read as a mistake.
 */

/** `[text](https://…)` — the one inline construct the generators emit. */
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Escaped text with our links restored.
 *
 * The order is the whole safety argument: escape the entire line first, then
 * match link syntax in the *escaped* text and build the anchor from captured
 * groups that have already been through `escapeHtml`. A `javascript:` URL
 * cannot match, and a stray `<script>` in the source is already `&lt;script&gt;`
 * by the time anything looks at it.
 */
function inlineHtml(text: string): string {
  return escapeHtml(text).replace(LINK, (_match, label: string, url: string) => `<a href="${url}">${label}</a>`);
}

interface Block {
  kind: "heading" | "bullets" | "paragraph";
  lines: string[];
}

/** Groups the lines into blocks, so a run of bullets becomes one list. */
function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("# ")) continue; // The document's own title says this already.
    if (line.startsWith("## ") || line.startsWith("### ")) {
      blocks.push({ kind: "heading", lines: [line.replace(/^#{2,3}\s+/, "")] });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "bullets") last.lines.push(line.replace(/^[-*]\s+/, ""));
      else blocks.push({ kind: "bullets", lines: [line.replace(/^[-*]\s+/, "")] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "paragraph") last.lines.push(line);
    else blocks.push({ kind: "paragraph", lines: [line] });
  }
  return blocks;
}

/**
 * The document body for a stored Markdown summary — safe to hand to
 * `renderDocumentHtml`'s `bodyHtml`, because every character in it either came
 * from this file or came through `escapeHtml`.
 */
export function documentBodyFromMarkdown(markdown: string): string {
  return blocksOf(markdown)
    .map((block) => {
      if (block.kind === "heading") return `<h2>${inlineHtml(block.lines[0]!)}</h2>`;
      if (block.kind === "bullets") return `<ul>${block.lines.map((line) => `<li>${inlineHtml(line)}</li>`).join("")}</ul>`;
      return `<p>${block.lines.map((line) => inlineHtml(line)).join("<br />")}</p>`;
    })
    .join("\n");
}
