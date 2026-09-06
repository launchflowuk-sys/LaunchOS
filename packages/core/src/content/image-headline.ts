/**
 * Turning a post into the few words that go on a graphic. Pure text, no
 * database and no rendering, so the trimming can be tested on its own — it is
 * where a branded image most easily ends up looking broken.
 */

/** A full stop, a colon or a dash with a space after it: where the first thought ends. */
const SENTENCE_END = /[.!?…]\s|[;:]\s|\s[—–]\s/;

/** Trailing punctuation a headline reads better without. An exclamation or a question mark is kept. */
const TRAILING = /[.,;:—–\s]+$/;

/**
 * A headline for the graphic, taken from the opening of the post.
 *
 * The first sentence or clause, not the first N characters: a headline cut
 * mid-word looks like the software broke, and one cut at a full stop looks
 * like somebody wrote it. Only when that first clause is itself too long does
 * this trim, and then on a word boundary with an ellipsis to show it did.
 */
export function headlineFrom(text: string, max = 120): string {
  const cleaned = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")            // markdown images leave nothing readable behind
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")          // links keep their words, drop their URL
    .replace(/[#*_`>]/g, " ");                        // heading, emphasis and quote marks

  // The first line that says anything: a blog post opens with its heading, and
  // a paragraph break is a firmer stop than any full stop inside a paragraph.
  const line = cleaned.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  const flat = (line ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";

  const split = flat.split(SENTENCE_END)[0]!.trim();
  const first = split.length > 0 ? split : flat;
  if (first.length <= max) return first.replace(TRAILING, "");

  const cut = first.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Cut mid-word only when there is no space worth cutting at — one very long
  // word, which the renderer would have to break anyway.
  const trimmed = (lastSpace > max / 2 ? cut.slice(0, lastSpace) : first.slice(0, max)).replace(TRAILING, "");
  return `${trimmed}…`;
}

/** The small line above the headline: the client's town, from the brief's `area`. */
export function kickerFrom(area: string | null | undefined, max = 40): string | undefined {
  const first = (area ?? "").split(/[,/·|]/)[0]!.replace(/\s+/g, " ").trim();
  if (!first || first.length > max) return undefined;
  return first;
}
