const BRIEF_DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * "Wednesday 9 September 2026" from the `brief_date` column, which is a
 * calendar date with no zone. Read as UTC midnight and printed in UTC, so the
 * day named is the day stored on every machine.
 */
export function briefDateLabel(briefDate: string): string {
  const at = new Date(`${briefDate}T00:00:00Z`);
  // ICU writes "Wednesday, 9 September" for en-GB; the comma is not how the day is said.
  return Number.isNaN(at.getTime()) ? briefDate : BRIEF_DATE.format(at).replace(",", "");
}

/** The first few lines of a brief as plain text, for the dashboard card. */
export function briefExcerpt(bodyMd: string, maxLines = 3): string[] {
  const lines: string[] = [];
  for (const raw of bodyMd.split(/\r?\n/)) {
    const line = plainText(raw);
    if (line.length === 0) continue;
    lines.push(line);
    if (lines.length === maxLines) break;
  }
  return lines;
}

/** Strips the Markdown a brief is written in — headings, bullets, emphasis, links — down to a sentence. */
function plainText(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}
