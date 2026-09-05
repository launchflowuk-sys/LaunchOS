/**
 * The small markdown subset an agent draft may use, rendered to HTML that is
 * safe to POST into someone else's live website.
 *
 * Deliberately *not* a markdown library. The content here is written by a
 * language model and approved by a human reading the markdown source, and it
 * lands in a WordPress page that serves the client's customers. Two properties
 * matter more than fidelity:
 *
 * 1. **No raw HTML passes through.** Every character of the input is escaped
 *    before any markup is added, so a draft containing `<script>` publishes the
 *    visible text `<script>` and never a tag. A general converter with HTML
 *    pass-through would turn "approve this copy" into "approve this copy and
 *    whatever markup is hidden in it".
 * 2. **Only safe link schemes survive.** `javascript:` and `data:` hrefs are
 *    dropped back to their link text rather than rendered.
 *
 * `marked` is not in the lockfile, and pulling a parser in to gain footnotes and
 * tables would widen the attack surface of the one code path that writes to a
 * client's public site. Headings, paragraphs, lists, links, emphasis and code
 * are what the approval card can show a human in full.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM = /^[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\d+[.)]\s+(.*)$/;
/** `/path`, `#anchor`, `./rel`, `http(s)://…`, `mailto:…` — nothing else. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/|#|\.\/|\.\.\/)/i;
/** Where a lifted-out code span or link sits until the emphasis pass is done. */
const PLACEHOLDER = /<(\d+)>/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

/**
 * Inline markup on already-escaped text.
 *
 * Code spans and links are lifted into `<0>`-style placeholders first, so that
 * emphasis cannot rewrite the inside of a code span or the middle of a URL.
 * `<` is a safe delimiter precisely because `escapeHtml` has already run: at
 * this point the string cannot contain a literal one.
 */
function renderInline(escaped: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `<${held.push(html) - 1}>`;

  let out = escaped.replace(/`([^`]+)`/g, (_all, code: string) => hold(`<code>${code}</code>`));

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, text: string, href: string) => {
    // The scheme test runs on the un-escaped href: `escapeHtml` turned `&` into
    // `&amp;`, which changes a query string but not a scheme, and nobody can
    // smuggle one past this by entity-encoding it — the browser reads the same
    // `&amp;` we wrote.
    const raw = href.replace(/&amp;/g, "&");
    if (!SAFE_HREF.test(raw)) return text;
    return hold(`<a href="${href}">${renderEmphasis(text)}</a>`);
  });

  return renderEmphasis(out).replace(PLACEHOLDER, (_all, index: string) => held[Number(index)] ?? "");
}

function renderList(lines: string[], tag: "ul" | "ol", pattern: RegExp): string {
  const items = lines.map((line) => `  <li>${renderInline(escapeHtml(pattern.exec(line)![1]!))}</li>`);
  return `<${tag}>\n${items.join("\n")}\n</${tag}>`;
}

function renderBlock(block: string): string | null {
  const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const heading = HEADING.exec(lines[0]!);
  if (heading && lines.length === 1) {
    const level = heading[1]!.length;
    return `<h${level}>${renderInline(escapeHtml(heading[2]!.trim()))}</h${level}>`;
  }

  if (lines.every((line) => UNORDERED_ITEM.test(line))) return renderList(lines, "ul", UNORDERED_ITEM);
  if (lines.every((line) => ORDERED_ITEM.test(line))) return renderList(lines, "ol", ORDERED_ITEM);

  return `<p>${renderInline(escapeHtml(lines.join(" ")))}</p>`;
}

/**
 * Markdown in, HTML out. Blank lines separate blocks; everything inside a block
 * is one paragraph, one heading, or one list.
 */
export function markdownToSafeHtml(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map(renderBlock)
    .filter((block): block is string => block !== null)
    .join("\n\n");
}
