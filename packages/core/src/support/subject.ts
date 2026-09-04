/**
 * Subject-line helpers shared by the two reply paths.
 *
 * They were a private copy in each file; a courtesy notice queued from
 * `replyToConversation` needs the same "Re:" rule an emailed reply uses, and a
 * portal reply needs the same trimming an inbound one does, so they live in one
 * place rather than drifting apart.
 */

/** `Re: ` exactly once, however many times a thread has been round. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * `activity_events.title` and `notifications.title` are both capped at 200, and
 * a subject is allowed 200 of its own — so a long one would throw at the Zod
 * boundary and roll back the whole reply. Trim rather than lose the message.
 */
export const TITLE_SUBJECT_LIMIT = 120;

export function shortSubject(subject: string): string {
  return subject.length <= TITLE_SUBJECT_LIMIT ? subject : `${subject.slice(0, TITLE_SUBJECT_LIMIT - 1)}…`;
}
