import { schema } from "@launchos/db";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * `messages.metadata.kind` on the courtesy notice a portal reply queues — the
 * "sign in to the portal to read it" nudge, never the answer itself.
 *
 * `(portal)/portal/support/[id]/page.tsx` carries the same string as a literal,
 * because importing `@launchos/core` into a portal page would drag the whole
 * domain layer into that route; keep the two in step.
 */
export const PORTAL_REPLY_NOTICE_KIND = "portal_reply_notice";

/**
 * True for the nudge rather than the answer.
 *
 * A Drizzle predicate rather than a JS check because every reader of a thread
 * has to exclude it, and they read in different shapes: the case screen and
 * `tickets_get` select the messages, the Inbox list takes only the newest one's
 * direction from a correlated subquery. One condition all three can put in the
 * same query is the only version that cannot drift.
 *
 * `coalesce` matters: `metadata->>'kind'` is NULL on every ordinary message, and
 * `not NULL` is NULL, which would filter out the whole thread rather than the
 * one row.
 *
 * @param metadata the `metadata` column to test — defaults to `messages`,
 * pass `sql\`m.metadata\`` when the query aliases the table.
 */
export function isCourtesyNotice(metadata: SQLWrapper = schema.messages.metadata): SQL<boolean> {
  return sql<boolean>`coalesce(${metadata}->>'kind', '') = ${PORTAL_REPLY_NOTICE_KIND}`;
}
