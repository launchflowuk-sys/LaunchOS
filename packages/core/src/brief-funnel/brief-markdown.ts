import { STAGES } from "./questionnaire.js";

/**
 * The brief, written from the answers alone.
 *
 * No model, no network, no failure mode. This is what exists the instant a
 * customer presses Send, and it is why an AI outage is a missing improvement
 * rather than a lost enquiry. Everything in here is either something the
 * customer typed or a label they were shown — it invents nothing, so it needs
 * no review before a human can rely on it.
 *
 * Written as Markdown because that is what both a staff screen and a model
 * prompt want, and it survives being pasted into an email.
 */

export interface BriefMarkdownOptions {
  reference: string;
  /**
   * Answers held in the draft whose question is no longer showing. Named in the
   * brief rather than silently dropped: "you told us about products and then
   * removed Sell online" is a thing worth being able to see.
   */
  excluded?: readonly string[];
}

/** Escapes the few characters that would otherwise become Markdown of their own. */
function plain(value: string): string {
  return value.replace(/([*_`#[\]])/g, "\\$1");
}

/** The words the customer saw, not the values we stored. */
function readable(key: string, raw: unknown): string {
  const field = STAGES.flatMap((stage) => stage.fields).find((f) => f.key === key);
  const one = (value: string) => field?.options?.find((option) => option.value === value)?.label ?? value;
  if (Array.isArray(raw)) return raw.map((entry) => one(String(entry))).join(", ");
  return one(String(raw ?? ""));
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function briefMarkdown(answers: Record<string, unknown>, options: BriefMarkdownOptions): string {
  const title = String(answers.business ?? answers.name ?? "Website brief");
  const lines: string[] = [
    `# Website brief — ${plain(title)}`,
    "",
    `**Reference:** ${options.reference}`,
    `**Received:** ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Everything below is in the customer's own words or from the options they",
    "chose. Nothing here has been interpreted or filled in.",
    "",
  ];

  for (const stage of STAGES) {
    if (stage.key === "review") continue;
    const rows = stage.fields
      .map((field) => ({ field, value: answers[field.key] }))
      .filter(({ value }) => !isEmpty(value));
    if (rows.length === 0) continue;

    lines.push(`## ${stage.title}`, "");
    for (const { field, value } of rows) {
      const text = readable(field.key, value);
      // A multi-line answer becomes a block quote rather than a table row, so
      // the customer's paragraphs survive as paragraphs.
      if (text.includes("\n")) {
        lines.push(`**${plain(field.label)}**`, "");
        for (const line of text.split("\n")) lines.push(`> ${plain(line)}`);
        lines.push("");
      } else {
        lines.push(`- **${plain(field.label)}:** ${plain(text)}`);
      }
    }
    lines.push("");
  }

  // What they sent. Names and sizes only — the files themselves stay in
  // private storage and are reached from the lead, never from this document.
  const attachments = Array.isArray(answers.attachments) ? answers.attachments : [];
  if (attachments.length > 0) {
    lines.push("## Files they sent", "");
    for (const entry of attachments as { name?: unknown; bytes?: unknown }[]) {
      const size = typeof entry.bytes === "number" ? ` (${Math.max(1, Math.round(entry.bytes / 1024))} KB)` : "";
      lines.push(`- ${plain(String(entry.name ?? "attachment"))}${size}`);
    }
    lines.push("");
  }

  // Named so nobody has to guess whether a blank means "no" or "not asked".
  const missing = STAGES.flatMap((stage) => stage.fields)
    .filter((field) => !field.showWhen && isEmpty(answers[field.key]))
    .map((field) => field.label);
  if (missing.length > 0) {
    lines.push("## Still to confirm", "");
    for (const label of missing) lines.push(`- ${plain(label)}`);
    lines.push("");
  }

  if (options.excluded && options.excluded.length > 0) {
    const labels = options.excluded.map((key) => {
      const field = STAGES.flatMap((stage) => stage.fields).find((f) => f.key === key);
      return field?.label ?? key;
    });
    lines.push(
      "## Answered, then taken out of scope",
      "",
      "The customer answered these and later changed the choice that asked for",
      "them. They are not requirements.",
      "",
    );
    for (const label of labels) lines.push(`- ${plain(label)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
