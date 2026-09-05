/** The Ops Brief agent's key: `agent_enablement.agent_key`, `audit_log.actor_id` and the registry entry. */
export const OPS_BRIEF_KEY = "ops-brief";

/** The length the prompt asks for. */
export const OPS_BRIEF_MAX_WORDS = 250;

/**
 * Where `ops_save_brief` stops accepting: some tolerance over the prompt's
 * limit, because a brief that runs to 260 words is not worth a second LLM
 * turn, but one twice the length has ignored the rule.
 */
export const OPS_BRIEF_HARD_MAX_WORDS = 320;

/** Word count as a person would count it: runs of non-space characters, Markdown markers included. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/** `YYYY-MM-DD` in Europe/London — the date a brief written this morning belongs to. */
export function londonDateKey(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
