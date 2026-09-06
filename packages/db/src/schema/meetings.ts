import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { leads } from "./leads.js";

export const meetingKindEnum = pgEnum("meeting_kind", ["discovery", "review", "support", "other"]);
export const meetingStatusEnum = pgEnum("meeting_status", ["scheduled", "rescheduled", "cancelled", "completed", "no_show"]);
export type MeetingKind = (typeof meetingKindEnum.enumValues)[number];
export type MeetingStatus = (typeof meetingStatusEnum.enumValues)[number];

/** The two statuses that still occupy a slot in the host's diary. */
export const MEETING_LIVE_STATUSES: readonly MeetingStatus[] = ["scheduled", "rescheduled"];

/**
 * A call somebody booked through our own booking page, held on Zoom (or the
 * mock). Anchored to a lead (a discovery call before they are a client) or a
 * client (a review or a support call) — or neither, when a stranger booked
 * from the public page; `bookMeeting` files those under a fresh lead so every
 * meeting has somebody to write to. `reschedule_token` is the unguessable
 * handle the guest's "change or cancel" link carries; `metadata` records which
 * reminders went out (`reminded24hAt`, `reminded1hAt`, `hostAlertedAt`), the
 * follow-up stamps and where the booking came from.
 */
export const meetings = pgTable("meetings", {
  ...tenantColumns(),
  kind: meetingKindEnum("kind").default("discovery").notNull(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  hostUserId: text("host_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  guestName: text("guest_name").notNull(),
  guestEmail: text("guest_email").notNull(),
  guestTimezone: text("guest_timezone").default("Europe/London").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: meetingStatusEnum("status").default("scheduled").notNull(),
  /** `zoom` or `mock` — which adapter minted `provider_meeting_id`. */
  provider: text("provider").notNull(),
  providerMeetingId: text("provider_meeting_id"),
  joinUrl: text("join_url").notNull(),
  hostUrl: text("host_url"),
  rescheduleToken: text("reschedule_token").notNull(),
  notes: text("notes"),
}, (t) => [
  index("meetings_org_starts").on(t.organisationId, t.startsAt),
  uniqueIndex("meetings_reschedule_token").on(t.rescheduleToken),
  // One live meeting per host per start time: the database, not a read-then-
  // insert, decides who got the slot when two guests pick the same one.
  // Partial so a cancelled meeting frees the slot for the next booking.
  uniqueIndex("meetings_host_live_slot")
    .on(t.hostUserId, t.startsAt)
    .where(sql`${t.status} in ('scheduled', 'rescheduled')`),
]);
