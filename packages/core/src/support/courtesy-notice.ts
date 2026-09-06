import { schema } from "@launchos/db";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * `messages.metadata.kind` on the courtesy notice a portal reply queues — the
 * "sign in to the portal to read it" nudge, never the answer itself.
 *
 * `(portal)/portal/support/[id]/page.tsx` carries the same strings as
 * literals, because importing `@launchos/core` into a portal page would drag
 * the whole domain layer into that route; keep the two in step.
 */
export const PORTAL_REPLY_NOTICE_KIND = "portal_reply_notice";

/**
 * `metadata.kind` on the acknowledgement queued the moment a client raises a
 * case — "we've got your request". Sent once per ticket, by
 * `queueCaseAcknowledgement`, and never a reply: `firstResponseAt` stays null.
 */
export const CASE_ACKNOWLEDGEMENT_KIND = "case_acknowledgement";

/**
 * `metadata.kind` on the email that tells a client their plan change request
 * was approved or declined (`applySubscriptionChangeDecision`).
 */
export const SUBSCRIPTION_CHANGE_NOTICE_KIND = "subscription_change_notice";

/**
 * `metadata.kind` on the "Was this sorted?" email `queueCsatInvite` writes the
 * moment a client-visible case is resolved. Five score links, one page.
 */
export const CSAT_INVITE_KIND = "csat_invite";

/**
 * `metadata.kind` on the email that carries a month's content report to the
 * client's portal users once the owner approved sending it
 * (`applyContentReportSendDecision`).
 */
export const CONTENT_REPORT_NOTICE_KIND = "content_report_notice";

/**
 * `metadata.kind` on the "We've got your enquiry" email `queueLeadAcknowledgement`
 * writes the moment a lead arrives from the website, a signup or a funnel.
 * Carries the booking link; never a reply.
 */
export const LEAD_ACKNOWLEDGEMENT_KIND = "lead_acknowledgement";

/**
 * `metadata.kind` on a meeting email: the booking confirmation, a reminder,
 * a reschedule or cancellation notice, the "sorry we missed you". All from
 * `packages/core/src/meetings`; `metadata.meetingId` names the meeting and
 * `metadata.notice` says which of them it is.
 */
export const MEETING_NOTICE_KIND = "meeting_notice";

/**
 * `metadata.kind` on a proposal email: the priced offer going out, the
 * "you've accepted" confirmation, the decline acknowledgement. All from
 * `packages/core/src/proposals`; `metadata.proposalId` names the proposal and
 * `metadata.notice` says which of them it is.
 */
export const PROPOSAL_NOTICE_KIND = "proposal_notice";

/**
 * `metadata.kind` on the weekly project update Shoji approved
 * (`applyProjectUpdateDecision`). `metadata.projectId` names the build.
 *
 * A courtesy notice even though it carries real news, because the definition
 * below is about threads, not importance: it is an outbound record on a
 * conversation of its own, and a reader of a support case must never see it as
 * a turn in that case.
 */
export const PROJECT_UPDATE_NOTICE_KIND = "project_update_notice";

/**
 * `metadata.kind` on the same-day note that a milestone was reached
 * (`queueMilestoneNotice`). `metadata.milestoneId` names the promise kept.
 */
export const PROJECT_MILESTONE_NOTICE_KIND = "project_milestone_notice";

/**
 * Every kind of message that is a record of an email we sent *about* a thread
 * rather than a turn in it. All of them are `outbound` rows written by the
 * system, and all of them must be invisible to every reader of the thread —
 * the case screen, the Inbox's "who spoke last" column, the agents' `tickets_get`
 * and the portal — or an acknowledgement would look like an answer and the
 * "needs reply" badge would vanish from a case nobody has touched.
 */
export const COURTESY_NOTICE_KINDS = [
  PORTAL_REPLY_NOTICE_KIND,
  CASE_ACKNOWLEDGEMENT_KIND,
  SUBSCRIPTION_CHANGE_NOTICE_KIND,
  CSAT_INVITE_KIND,
  CONTENT_REPORT_NOTICE_KIND,
  LEAD_ACKNOWLEDGEMENT_KIND,
  MEETING_NOTICE_KIND,
  PROPOSAL_NOTICE_KIND,
  PROJECT_UPDATE_NOTICE_KIND,
  PROJECT_MILESTONE_NOTICE_KIND,
] as const;

export type CourtesyNoticeKind = (typeof COURTESY_NOTICE_KINDS)[number];

/**
 * True for a nudge rather than an answer.
 *
 * A Drizzle predicate rather than a JS check because every reader of a thread
 * has to exclude it, and they read in different shapes: the case screen and
 * `tickets_get` select the messages, the Inbox list takes only the newest one's
 * direction from a correlated subquery. One condition all three can put in the
 * same query is the only version that cannot drift.
 *
 * `coalesce` matters: `metadata->>'kind'` is NULL on every ordinary message, and
 * `NULL = any(...)` is NULL, which would filter out the whole thread rather
 * than the one row.
 *
 * @param metadata the `metadata` column to test — defaults to `messages`,
 * pass `sql\`m.metadata\`` when the query aliases the table.
 */
export function isCourtesyNotice(metadata: SQLWrapper = schema.messages.metadata): SQL<boolean> {
  const kinds = sql.join(
    COURTESY_NOTICE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql<boolean>`coalesce(${metadata}->>'kind', '') = any(array[${kinds}]::text[])`;
}

/** The JS twin of `isCourtesyNotice`, for rows already in memory. */
export function isCourtesyNoticeRow(metadata: Record<string, unknown>): boolean {
  const kind = metadata["kind"];
  return typeof kind === "string" && (COURTESY_NOTICE_KINDS as readonly string[]).includes(kind);
}
