import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import { appUrl, brandSupportAddress } from "../config.js";
import { ensureLeadConversation } from "../leads/acknowledge.js";
import { bookingLinkFor, BOOKING_PATH } from "../leads/booking-link.js";
import { MEETING_NOTICE_KIND } from "../support/courtesy-notice.js";
import { formatInZone } from "./time.js";

export type MeetingRow = typeof schema.meetings.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

export type MeetingNoticeKind = "confirmation" | "reminder" | "rescheduled" | "cancelled" | "no_show";

/** `meetings.metadata.conversationId` — the thread a client's meeting emails file on. */
export const MEETING_CONVERSATION_ID = "conversationId";

/** The guest's "change or cancel" page, keyed by the unguessable token. */
export function meetingManageUrl(meeting: Pick<MeetingRow, "rescheduleToken">, env: NodeJS.ProcessEnv = process.env): string {
  return `${appUrl(env)}${BOOKING_PATH}/r/${encodeURIComponent(meeting.rescheduleToken)}`;
}

/** The `.ics` for this meeting, served by the web route under the same token. */
export function meetingIcsUrl(meeting: Pick<MeetingRow, "rescheduleToken">, env: NodeJS.ProcessEnv = process.env): string {
  return `${meetingManageUrl(meeting, env)}/calendar.ics`;
}

/** Where a guest books again after a cancellation or a no-show. */
export async function rebookUrl(db: Db, meeting: Pick<MeetingRow, "leadId" | "organisationId">, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (meeting.leadId) {
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, meeting.leadId));
    if (lead) return bookingLinkFor(lead, env);
  }
  return `${appUrl(env)}${BOOKING_PATH}`;
}

/** "Tuesday 15 September 2026, 14:30 BST (13:30 GMT+5 your time)" — both zones when they differ. */
export function describeMeetingTime(meeting: Pick<MeetingRow, "startsAt" | "guestTimezone">, hostTimezone: string): string {
  const guest = formatInZone(meeting.startsAt, meeting.guestTimezone);
  if (meeting.guestTimezone === hostTimezone) return guest;
  return `${guest} (${formatInZone(meeting.startsAt, hostTimezone, "short")} for us)`;
}

/**
 * The thread this meeting's emails file on: a lead's own thread, or — for a
 * client — one conversation per meeting, remembered on the meeting.
 */
export async function ensureMeetingConversation(db: Db, organisationId: string, meeting: MeetingRow): Promise<ConversationRow> {
  if (meeting.leadId) {
    const [lead] = await db.select().from(schema.leads)
      .where(and(eq(schema.leads.id, meeting.leadId), eq(schema.leads.organisationId, organisationId)));
    if (lead) return ensureLeadConversation(db, organisationId, lead);
  }
  const remembered = meeting.metadata[MEETING_CONVERSATION_ID];
  if (typeof remembered === "string") {
    const [existing] = await db.select().from(schema.conversations)
      .where(and(eq(schema.conversations.id, remembered), eq(schema.conversations.organisationId, organisationId)));
    if (existing) return existing;
  }
  if (!meeting.clientId) throw new Error(`meeting ${meeting.id} has neither a lead nor a client to write to`);
  const now = new Date();
  const [created] = await db.insert(schema.conversations).values({
    organisationId, clientId: meeting.clientId,
    subject: `Your call with LaunchFlow`,
    channel: "email", status: "closed", lastMessageAt: now, participantEmail: meeting.guestEmail,
  }).returning();
  await db.update(schema.meetings)
    .set({
      metadata: sql`coalesce(${schema.meetings.metadata}, '{}'::jsonb) || ${JSON.stringify({ [MEETING_CONVERSATION_ID]: created!.id })}::jsonb`,
      updatedAt: now,
    })
    .where(eq(schema.meetings.id, meeting.id));
  return created!;
}

export interface QueueMeetingNoticeInput {
  meeting: MeetingRow;
  notice: MeetingNoticeKind;
  subject: string;
  body: string;
  /** Extra metadata for the branded shell (`joinUrl`, `manageUrl`, `bookingUrl`). */
  links?: { joinUrl?: string | undefined; manageUrl?: string | undefined; bookingUrl?: string | undefined } | undefined;
  actorKind?: "user" | "client" | "agent" | "system" | undefined;
  actorId?: string | undefined;
}

/**
 * Queues one branded email to the guest about their meeting, on the thread
 * `ensureMeetingConversation` finds. A courtesy notice (`metadata.kind =
 * meeting_notice`, `metadata.notice` says which), so no thread reader shows it
 * as a turn. Runs in the caller's transaction; the caller emits
 * `message.queued` after commit.
 */
export async function queueMeetingNotice(db: Db, organisationId: string, input: QueueMeetingNoticeInput, env: NodeJS.ProcessEnv = process.env): Promise<MessageRow> {
  const conversation = await ensureMeetingConversation(db, organisationId, input.meeting);
  const now = new Date();
  const [message] = await db.insert(schema.messages).values({
    organisationId,
    conversationId: conversation.id,
    direction: "outbound",
    authorKind: "system",
    authorId: null,
    body: input.body,
    fromEmail: brandSupportAddress(env),
    toEmail: input.meeting.guestEmail,
    subject: input.subject,
    status: "queued",
    metadata: {
      kind: MEETING_NOTICE_KIND,
      notice: input.notice,
      meetingId: input.meeting.id,
      ...(input.links?.joinUrl ? { joinUrl: input.links.joinUrl } : {}),
      ...(input.links?.manageUrl ? { manageUrl: input.links.manageUrl } : {}),
      ...(input.links?.bookingUrl ? { bookingUrl: input.links.bookingUrl } : {}),
    },
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(schema.conversations.id, conversation.id));
  await recordAudit(db, organisationId, {
    actorKind: input.actorKind ?? "system", actorId: input.actorId, action: "message.queued", targetType: "message", targetId: message!.id, after: message,
  });
  return message!;
}

/** The stored body of the confirmation — the record of what the guest was told. */
export function confirmationBody(meeting: MeetingRow, hostTimezone: string, env: NodeJS.ProcessEnv = process.env): string {
  const first = meeting.guestName.split(/\s+/)[0] || meeting.guestName;
  return [
    `Hi ${first},`,
    `Your call with Shoji is booked for ${describeMeetingTime(meeting, hostTimezone)}. It's a video call on Zoom — join from your laptop or phone:`,
    meeting.joinUrl,
    `Add it to your calendar: ${meetingIcsUrl(meeting, env)}`,
    `Need to change or cancel? ${meetingManageUrl(meeting, env)}`,
    `Speak soon,\nThe LaunchFlow team`,
  ].join("\n\n");
}

export function reminderBody(meeting: MeetingRow, hostTimezone: string, horizon: "24h" | "1h", env: NodeJS.ProcessEnv = process.env): string {
  const first = meeting.guestName.split(/\s+/)[0] || meeting.guestName;
  const when = horizon === "24h" ? "tomorrow" : "in about an hour";
  return [
    `Hi ${first},`,
    `A quick reminder: your call with Shoji is ${when} — ${describeMeetingTime(meeting, hostTimezone)}. Join here:`,
    meeting.joinUrl,
    `Need to change or cancel? ${meetingManageUrl(meeting, env)}`,
    `The LaunchFlow team`,
  ].join("\n\n");
}

export function rescheduledBody(meeting: MeetingRow, hostTimezone: string, env: NodeJS.ProcessEnv = process.env): string {
  const first = meeting.guestName.split(/\s+/)[0] || meeting.guestName;
  return [
    `Hi ${first},`,
    `Your call with Shoji has moved to ${describeMeetingTime(meeting, hostTimezone)}. The join link is the same:`,
    meeting.joinUrl,
    `Updated calendar file: ${meetingIcsUrl(meeting, env)}`,
    `Need to change it again? ${meetingManageUrl(meeting, env)}`,
    `The LaunchFlow team`,
  ].join("\n\n");
}

export function cancelledBody(meeting: MeetingRow, hostTimezone: string, bookingUrl: string, reason?: string | null): string {
  const first = meeting.guestName.split(/\s+/)[0] || meeting.guestName;
  return [
    `Hi ${first},`,
    `Your call with Shoji on ${describeMeetingTime(meeting, hostTimezone)} has been cancelled${reason ? ` — ${reason}` : ""}.`,
    `If you'd still like to talk, pick another time here:`,
    bookingUrl,
    `The LaunchFlow team`,
  ].join("\n\n");
}

export function noShowBody(meeting: MeetingRow, hostTimezone: string, bookingUrl: string): string {
  const first = meeting.guestName.split(/\s+/)[0] || meeting.guestName;
  return [
    `Hi ${first},`,
    `Sorry we missed you on ${describeMeetingTime(meeting, hostTimezone)} — these things happen. If you'd still like to talk it through, pick another time and it goes straight into Shoji's diary:`,
    bookingUrl,
    `Or just reply to this email.`,
    `The LaunchFlow team`,
  ].join("\n\n");
}
