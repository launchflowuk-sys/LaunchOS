import { isCourtesyNotice } from "@launchos/core";
import { schema } from "@launchos/db";
import { not, sql, type SQL } from "drizzle-orm";

/**
 * The two ways an admin screen reads a support thread, kept in one file
 * because they answer the same question and fail the same way.
 *
 * The courtesy notice ("sign in to the portal to read it") is written to the
 * same conversation as the reply it announces, so every staff-side read has to
 * leave it out — the case screen lists the messages, the Inbox takes only the
 * newest one's direction. Both conditions are hand-written SQL around
 * `isCourtesyNotice`, and both fail silently when they are wrong: a lost
 * `coalesce` empties the thread, a lost filter makes the newest row a machine's
 * and the "needs reply" badge disappears from every conversation a client is
 * waiting on. Nothing throws either way, so they are tested rather than read.
 */

/**
 * Every message a colleague should see on a case thread — the answers and the
 * notes, not the nudge that told the client to come and read them.
 */
export function excludingCourtesyNotice(): SQL<unknown> {
  return not(isCourtesyNotice());
}

/**
 * The `direction` of the newest real message on a conversation, or NULL for a
 * thread that holds nothing but notices.
 *
 * A correlated subquery rather than a join plus group by: one row per
 * conversation, and "who spoke last" stays a property of the thread's messages
 * rather than a counter to keep in step by hand. `inbound` means the last word
 * was the client's, which is the Inbox's "needs reply" badge.
 *
 * Correlates against `conversations` by name rather than taking the outer
 * column as an argument: Drizzle renders a bare column unqualified when the
 * outer select reads from a single table, and an unqualified `"id"` inside this
 * subquery binds to `messages.id` — which matches nothing, so every row comes
 * back NULL and the badge disappears without an error. Written out, it is
 * qualified whatever the outer query looks like. The outer query must therefore
 * select from `conversations` under its own name, not an alias.
 */
export function lastMessageDirection(): SQL<string | null> {
  return sql<string | null>`(
    select m.direction from ${schema.messages} m
    where m.conversation_id = ${schema.conversations}."id"
      and not ${isCourtesyNotice(sql`m.metadata`)}
    order by m.created_at desc limit 1
  )`;
}
