import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { MEETING_LIVE_STATUSES } from "@launchos/db/schema";
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { emit } from "../events/emit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { NO_SHOW_EMAILED_AT, meetingsNeedingOutcome } from "./manage.js";
import { meetingManageUrl, noShowBody, queueMeetingNotice, rebookUrl, reminderBody, type MeetingRow } from "./notices.js";
import { getBookingSettings } from "./settings.js";
import { formatInZone } from "./time.js";

/** The host's phone, fifteen minutes out. Urgent. */
export const MEETING_STARTING_NOTIFICATION_KIND = "meeting.starting";
/** The owner's bell: a call ended and nobody said how it went. */
export const MEETING_OUTCOME_NOTIFICATION_KIND = "meeting.outcome_needed";

export const REMINDED_24H_AT = "reminded24hAt";
export const REMINDED_1H_AT = "reminded1hAt";
export const HOST_ALERTED_AT = "hostAlertedAt";
export const OUTCOME_NUDGED_AT = "outcomeNudgedAt";

const HOUR = 3_600_000;
export const REMINDER_24H_MS = 24 * HOUR;
export const REMINDER_1H_MS = 1 * HOUR;
export const HOST_ALERT_MS = 15 * 60_000;

export interface ReminderSweepResult {
  reminded24h: string[];
  reminded1h: string[];
  hostAlerted: string[];
}

/**
 * Claims one stamp on one meeting: a conditional UPDATE, so two ticks of the
 * cron overlapping cannot both send. Returns the row when this call won.
 */
async function claimStamp(db: Db, organisationId: string, meetingId: string, key: string, now: Date): Promise<MeetingRow | undefined> {
  const [row] = await db.update(schema.meetings)
    .set({ metadata: sql`coalesce(${schema.meetings.metadata}, '{}'::jsonb) || ${JSON.stringify({ [key]: now.toISOString() })}::jsonb`, updatedAt: now })
    .where(and(
      eq(schema.meetings.id, meetingId), eq(schema.meetings.organisationId, organisationId),
      sql`(${schema.meetings.metadata}->>${key}) IS NULL`,
    ))
    .returning();
  return row;
}

async function liveMeetingsStartingWithin(db: Db, organisationId: string, now: Date, withinMs: number, unstamped: string): Promise<MeetingRow[]> {
  return db.select().from(schema.meetings)
    .where(and(
      eq(schema.meetings.organisationId, organisationId), isNull(schema.meetings.deletedAt),
      inArray(schema.meetings.status, [...MEETING_LIVE_STATUSES]),
      gt(schema.meetings.startsAt, now),
      lte(schema.meetings.startsAt, new Date(now.getTime() + withinMs)),
      sql`(${schema.meetings.metadata}->>${unstamped}) IS NULL`,
    ))
    .orderBy(asc(schema.meetings.startsAt), asc(schema.meetings.id));
}

/**
 * The `meetings.remind` sweep for one organisation: a guest email at T-24h
 * and T-1h, the host's phone at T-15m. Each is stamped on the meeting under
 * a conditional UPDATE, so a tick that overlaps the last one, or a meeting
 * booked with less than 24 hours to go, sends each reminder at most once. A
 * rescheduled meeting has its stamps cleared, so the new time is reminded
 * afresh.
 */
export async function sendMeetingReminders(db: Db, organisationId: string, options: { now?: Date } = {}, env: NodeJS.ProcessEnv = process.env): Promise<ReminderSweepResult> {
  const now = options.now ?? new Date();
  const settings = await getBookingSettings(db, organisationId);
  const result: ReminderSweepResult = { reminded24h: [], reminded1h: [], hostAlerted: [] };

  for (const [key, withinMs, horizon, bucket] of [
    [REMINDED_24H_AT, REMINDER_24H_MS, "24h", result.reminded24h],
    [REMINDED_1H_AT, REMINDER_1H_MS, "1h", result.reminded1h],
  ] as const) {
    for (const candidate of await liveMeetingsStartingWithin(db, organisationId, now, withinMs, key)) {
      const queued = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const meeting = await claimStamp(tx, organisationId, candidate.id, key, now);
        if (!meeting) return null;
        return queueMeetingNotice(tx, organisationId, {
          meeting, notice: "reminder",
          subject: horizon === "24h"
            ? `Tomorrow: your call with LaunchFlow, ${formatInZone(meeting.startsAt, meeting.guestTimezone, "short")}`
            : `In an hour: your call with LaunchFlow`,
          body: reminderBody(meeting, settings.timezone, horizon, env),
          links: { joinUrl: meeting.joinUrl, manageUrl: meetingManageUrl(meeting, env) },
        }, env);
      });
      if (queued) {
        await emit({ name: "message.queued", organisationId, messageId: queued.id });
        bucket.push(candidate.id);
      }
    }
  }

  for (const candidate of await liveMeetingsStartingWithin(db, organisationId, now, HOST_ALERT_MS, HOST_ALERTED_AT)) {
    const meeting = await claimStamp(db, organisationId, candidate.id, HOST_ALERTED_AT, now);
    if (!meeting) continue;
    await notify(db, organisationId, {
      userId: meeting.hostUserId, kind: MEETING_STARTING_NOTIFICATION_KIND,
      title: `Call in 15 minutes: ${meeting.guestName}`,
      body: `${formatInZone(meeting.startsAt, settings.timezone, "short")} — ${meeting.hostUrl ?? meeting.joinUrl}`,
      link: `/meetings/${meeting.id}`,
    });
    result.hostAlerted.push(meeting.id);
  }
  return result;
}

export interface FollowUpSweepResult {
  outcomeNudged: string[];
  noShowEmailed: string[];
}

/**
 * The `meetings.follow-up` sweep: a call that ended more than two hours ago
 * with no outcome rings the owner's bell once ("mark how it went"); a
 * no-show that was never emailed gets the one "sorry we missed you" — the
 * normal path queues it from `markMeetingOutcome`, so this catches only a
 * row marked some other way.
 */
export async function followUpMeetings(db: Db, organisationId: string, options: { now?: Date } = {}, env: NodeJS.ProcessEnv = process.env): Promise<FollowUpSweepResult> {
  const now = options.now ?? new Date();
  const settings = await getBookingSettings(db, organisationId);
  const result: FollowUpSweepResult = { outcomeNudged: [], noShowEmailed: [] };

  for (const candidate of await meetingsNeedingOutcome(db, organisationId, { now })) {
    if (typeof candidate.metadata[OUTCOME_NUDGED_AT] === "string") continue;
    const meeting = await claimStamp(db, organisationId, candidate.id, OUTCOME_NUDGED_AT, now);
    if (!meeting) continue;
    await notifyOwner(db, organisationId, {
      kind: MEETING_OUTCOME_NOTIFICATION_KIND,
      title: `How did the call with ${meeting.guestName} go?`,
      body: `${formatInZone(meeting.startsAt, settings.timezone, "short")}. Mark it completed or a no-show so the follow-up goes out.`,
      link: `/meetings/${meeting.id}`,
    });
    result.outcomeNudged.push(meeting.id);
  }

  const noShows = await db.select().from(schema.meetings)
    .where(and(
      eq(schema.meetings.organisationId, organisationId), isNull(schema.meetings.deletedAt),
      eq(schema.meetings.status, "no_show"),
      sql`(${schema.meetings.metadata}->>${NO_SHOW_EMAILED_AT}) IS NULL`,
    ))
    .orderBy(asc(schema.meetings.startsAt), asc(schema.meetings.id));
  for (const candidate of noShows) {
    const bookingUrl = await rebookUrl(db, candidate, env);
    const queued = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const meeting = await claimStamp(tx, organisationId, candidate.id, NO_SHOW_EMAILED_AT, now);
      if (!meeting) return null;
      return queueMeetingNotice(tx, organisationId, {
        meeting, notice: "no_show", subject: "Sorry we missed you — pick another time?",
        body: noShowBody(meeting, settings.timezone, bookingUrl), links: { bookingUrl },
      }, env);
    });
    if (queued) {
      await emit({ name: "message.queued", organisationId, messageId: queued.id });
      result.noShowEmailed.push(candidate.id);
    }
  }
  return result;
}
