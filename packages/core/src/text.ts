/**
 * Bounds for text that arrives from outside and ends up in a notification, an
 * activity entry or an audit title.
 *
 * `recordActivity` and `notify` both validate `title` at 200 characters and
 * `body` at 4000 (`activity/record-activity.ts`, `notifications/notify.ts`), and
 * a Zod failure there is a *throw* in the middle of whatever was reporting bad
 * news. That is the worst possible place for one: the give-up alerts, the
 * send-failure announcement and the sweeps' notifications all exist precisely
 * because something has already gone wrong, so an alert that cannot be
 * constructed turns a visible failure into a silent one.
 *
 * The values below are the two that actually arrive from outside:
 *
 * - `MAX_ADDRESS_CHARS` — `messages.to_email` is a `text` column copied off an
 *   inbound message's `From` header, so its length is the sender's choice.
 * - `MAX_ERROR_CHARS` — an adapter error is whatever the relay said, which can
 *   be a whole SMTP transcript.
 *
 * Both are well inside the 200/4000 limits with room for the surrounding
 * sentence, which is the point: callers interpolate them without arithmetic.
 */
export const MAX_ADDRESS_CHARS = 120;
export const MAX_ERROR_CHARS = 500;

/**
 * `value` capped at `max` characters, with an ellipsis standing in for what was
 * dropped. Never returns more than `max` characters, so a caller can add its
 * own fixed wording and stay under a schema limit by construction.
 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
