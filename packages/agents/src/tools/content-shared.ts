/**
 * What every content tool shares: the agent key the audit rows name, and the
 * per-channel limits the tools enforce in code rather than trusting the prompt.
 */

/** `audit_log.actor_id` for everything the writer touches. */
export const CONTENT_WRITER_KEY = "content-writer";

/**
 * Google refuses a local post whose summary is over 1500 code points, and
 * `GbpPublisher` rejects it before sending — so a longer draft would only
 * ever fail at publish time, weeks after the writer ran. Refused at save.
 */
export const GBP_MAX_BODY_CHARS = 1500;

/** The social ceiling the prompt asks for; the brief may lift it, so it is advisory here. */
export const SOCIAL_TARGET_MAX_CHARS = 280;

/** Counts code points, the way Google does, not UTF-16 units. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}
