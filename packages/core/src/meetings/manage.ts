import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { MEETING_LIVE_STATUSES } from "@launchos/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notify } from "../notifications/notify.js";
import { MeetingRefused, type MeetingDeps } from "./book.js";
import { cancelledBody, meetingManageUrl, noShowBody, queueMeetingNotice, rebookUrl, rescheduledBody, type MeetingRow } from "./notices.js";
import { getBookingSettings } from "./settings.js";
import { isSlotAvailable } from "./slots.js";
import { formatInZone } from "./time.js";

export const MEETING_RESCHEDULED_NOTIFICATION_KIND = "meeting.rescheduled";
export const MEETING_CANCELLED_NOTIFICATION_KIND = "meeting.cancelled";

/** `meetings.metadata` — set once the "sorry we missed you" email has been queued. */
export const NO_SHOW_EMAILED_AT = "noShowEmailedAt";

export async function getMeeting(db: Db, organisationId: string, meetingId: string): Promise<MeetingRow | null> {
  const [row] = await db.select().from(schema.meetings)
    .where(and(eq(schema.meetings.id, meetingId), eq(schema.meetings.organisationId, organisationId), isNull(schema.meetings.deletedAt)));
  return row ?? null;
}

/** By the guest's token, across organisations — the public change/cancel page has no organisation until it finds the meeting. */
export async function getMeetingByToken(db: Db, token: string): Promise<MeetingRow | null> {
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed.length > 128) return null;
  const [row] = await db.select().from(schema.meetings)
    .where(and(eq(schema.meetings.rescheduleToken, trimmed), isNull(schema.meetings.deletedAt)))
    .limit(1);
  return row ?? null;
}

export const ListMeetingsInput = z.object({
  /** `upcoming` = live and not yet ended; `past` = everything else, newest first. */
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  status: z.enum(schema.meetingStatusEnum.enumValues).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  now: z.date().optional(),
});
export type ListMeetingsInput = z.input<typeof ListMeetingsInput>;

export async function listMeetings(db: Db, organisationId: string, input: ListMeetingsInput = {}): Promise<MeetingRow[]> {
  const v = ListMeetingsInput.parse(input);
  const now = v.now ?? new Date();
  const where = and(
    eq(schema.meetings.organisationId, organisationId),
    isNull(schema.meetings.deletedAt),
    v.leadId ? eq(schema.meetings.leadId, v.leadId) : undefined,
    v.clientId ? eq(schema.meetings.clientId, v.clientId) : undefined,
    v.status ? eq(schema.meetings.status, v.status) : undefined,
    v.scope === "upcoming" ? and(inArray(schema.meetings.status, [...MEETING_LIVE_STATUSES]), gte(schema.meetings.endsAt, now)) : undefined,
    v.scope === "past" ? or(notInArray(schema.meetings.status, [...MEETING_LIVE_STATUSES]), lt(schema.meetings.endsAt, now)) : undefined,
  );
  const order = v.scope === "past" ? [desc(schema.meetings.startsAt), desc(schema.meetings.id)] : [asc(schema.meetings.startsAt), asc(schema.meetings.id)];
  return db.select().from(schema.meetings).where(where).orderBy(...order).limit(v.limit);
}

/** The next live meeting, for the dashboard tile. */
export async function nextMeeting(db: Db, organisationId: string, now = new Date()): Promise<MeetingRow | null> {
  const [row] = await listMeetings(db, organisationId, { scope: "upcoming", limit: 1, now });
  return row ?? null;
}

const Actor = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
};

export const RescheduleMeetingInput = z.object({
  meetingId: z.string().uuid(),
  startsAt: z.date(),
  /** The guest's zone when they move it themselves; unchanged otherwise. */
  guestTimezone: z.string().optional(),
  now: z.date().optional(),
  ...Actor,
});
export type RescheduleMeetingInput = z.input<typeof RescheduleMeetingInput>;

/**
 * Moves a live meeting. The new slot must be free (the meeting's own old slot
 * does not count against it); the provider is updated first, then the row,
 * with `SEQUENCE` bumped so the guest's calendar replaces the event; the guest
 * gets a "your call has moved" email and the host a bell.
 */
export async function rescheduleMeeting(db: Db, organisationId: string, input: RescheduleMeetingInput, deps: Pick<MeetingDeps, "meetings">, env: NodeJS.ProcessEnv = process.env) {
  const v = RescheduleMeetingInput.parse(input);
  const now = v.now ?? new Date();
  const before = await getMeeting(db, organisationId, v.meetingId);
  if (!before) throw new MeetingRefused("not_found", "That meeting could not be found.");
  if (!MEETING_LIVE_STATUSES.includes(before.status)) throw new MeetingRefused("not_live", "That meeting is no longer scheduled.");
  if (v.startsAt.getTime() <= now.getTime()) throw new MeetingRefused("past", "That time has already passed.");
  const settings = await getBookingSettings(db, organisationId);
  if (!(await isSlotAvailable(db, organisationId, v.startsAt, { now, excludeMeetingId: before.id }))) {
    throw new MeetingRefused("slot_taken", "That time is not available — please pick another.");
  }
  const endsAt = new Date(v.startsAt.getTime() + settings.slotMinutes * 60_000);
  if (before.providerMeetingId) {
    try {
      await deps.meetings.updateMeeting(before.providerMeetingId, { startsAt: v.startsAt, durationMinutes: settings.slotMinutes });
    } catch (error) {
      throw new MeetingRefused("provider_failed", `The call could not be moved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const sequence = (typeof before.metadata["sequence"] === "number" ? (before.metadata["sequence"] as number) : 0) + 1;

  let moved;
  try {
    moved = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const stamp = { sequence, previousStartsAt: before.startsAt.toISOString(), rescheduledAt: now.toISOString(), reminded24hAt: null, reminded1hAt: null, hostAlertedAt: null };
      const [after] = await tx.update(schema.meetings)
        .set({
          startsAt: v.startsAt, endsAt, status: "rescheduled",
          ...(v.guestTimezone ? { guestTimezone: v.guestTimezone } : {}),
          metadata: sql`coalesce(${schema.meetings.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(schema.meetings.id, before.id), eq(schema.meetings.organisationId, organisationId)))
        .returning();
      await recordAudit(tx, organisationId, { actorKind: v.actorKind, actorId: v.actorId, action: "meeting.rescheduled", targetType: "meeting", targetId: before.id, before, after });
      await recordActivity(tx, organisationId, {
        ...(after!.clientId ? { clientId: after!.clientId } : {}),
        actorKind: v.actorKind, actorId: v.actorId, kind: "meeting.rescheduled",
        title: `${after!.guestName}'s call moved to ${formatInZone(after!.startsAt, settings.timezone, "short")}`,
        link: `/meetings/${after!.id}`,
      });
      const notice = await queueMeetingNotice(tx, organisationId, {
        meeting: after!, notice: "rescheduled",
        subject: `Your call with LaunchFlow has moved: ${formatInZone(after!.startsAt, after!.guestTimezone, "short")}`,
        body: rescheduledBody(after!, settings.timezone, env),
        links: { joinUrl: after!.joinUrl, manageUrl: meetingManageUrl(after!, env) },
        actorKind: v.actorKind, actorId: v.actorId,
      }, env);
      return { after: after!, notice };
    });
  } catch (error) {
    const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
    if (code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505") {
      throw new MeetingRefused("slot_taken", "Somebody took that time a moment ago — please pick another.");
    }
    throw error;
  }

  await notify(db, organisationId, {
    userId: before.hostUserId, kind: MEETING_RESCHEDULED_NOTIFICATION_KIND,
    title: `Call moved: ${moved.after.guestName}, now ${formatInZone(moved.after.startsAt, settings.timezone, "short")}`,
    link: `/meetings/${moved.after.id}`,
  });
  await emit({ name: "message.queued", organisationId, messageId: moved.notice.id });
  return { meeting: moved.after, notice: moved.notice };
}

export const CancelMeetingInput = z.object({
  meetingId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
  now: z.date().optional(),
  ...Actor,
});
export type CancelMeetingInput = z.input<typeof CancelMeetingInput>;

/** Cancels a live meeting: provider first (best effort), then the row, the guest's email and the host's bell. */
export async function cancelMeeting(db: Db, organisationId: string, input: CancelMeetingInput, deps: Pick<MeetingDeps, "meetings">, env: NodeJS.ProcessEnv = process.env) {
  const v = CancelMeetingInput.parse(input);
  const now = v.now ?? new Date();
  const before = await getMeeting(db, organisationId, v.meetingId);
  if (!before) throw new MeetingRefused("not_found", "That meeting could not be found.");
  if (!MEETING_LIVE_STATUSES.includes(before.status)) throw new MeetingRefused("not_live", "That meeting is no longer scheduled.");
  const settings = await getBookingSettings(db, organisationId);
  if (before.providerMeetingId) {
    await deps.meetings.deleteMeeting(before.providerMeetingId).catch((error: unknown) => {
      console.error({ meetingId: before.id, error: error instanceof Error ? error.message : String(error) }, "provider meeting delete failed; the row is cancelled anyway");
    });
  }
  const bookingUrl = await rebookUrl(db, before, env);
  const sequence = (typeof before.metadata["sequence"] === "number" ? (before.metadata["sequence"] as number) : 0) + 1;

  const cancelled = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const stamp = { sequence, cancelledAt: now.toISOString(), cancelledByKind: v.actorKind, ...(v.actorId ? { cancelledById: v.actorId } : {}), ...(v.reason ? { cancelReason: v.reason } : {}) };
    const [after] = await tx.update(schema.meetings)
      .set({ status: "cancelled", metadata: sql`coalesce(${schema.meetings.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`, updatedAt: now })
      .where(and(eq(schema.meetings.id, before.id), eq(schema.meetings.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, { actorKind: v.actorKind, actorId: v.actorId, action: "meeting.cancelled", targetType: "meeting", targetId: before.id, before, after });
    await recordActivity(tx, organisationId, {
      ...(after!.clientId ? { clientId: after!.clientId } : {}),
      actorKind: v.actorKind, actorId: v.actorId, kind: "meeting.cancelled",
      title: `${after!.guestName}'s call on ${formatInZone(after!.startsAt, settings.timezone, "short")} was cancelled`,
      ...(v.reason ? { body: v.reason } : {}),
      link: `/meetings/${after!.id}`,
    });
    const notice = await queueMeetingNotice(tx, organisationId, {
      meeting: after!, notice: "cancelled",
      subject: "Your call with LaunchFlow has been cancelled",
      body: cancelledBody(after!, settings.timezone, bookingUrl, v.actorKind === "client" ? null : v.reason ?? null),
      links: { bookingUrl },
      actorKind: v.actorKind, actorId: v.actorId,
    }, env);
    return { after: after!, notice };
  });

  await notify(db, organisationId, {
    userId: before.hostUserId, kind: MEETING_CANCELLED_NOTIFICATION_KIND,
    title: `Call cancelled: ${cancelled.after.guestName}, ${formatInZone(cancelled.after.startsAt, settings.timezone, "short")}`,
    ...(v.reason ? { body: v.reason } : {}),
    link: `/meetings/${cancelled.after.id}`,
  });
  await emit({ name: "message.queued", organisationId, messageId: cancelled.notice.id });
  return { meeting: cancelled.after, notice: cancelled.notice };
}

export const MarkMeetingOutcomeInput = z.object({
  meetingId: z.string().uuid(),
  outcome: z.enum(["completed", "no_show"]),
  notes: z.string().trim().max(4000).optional(),
  actorId: z.string().min(1),
  now: z.date().optional(),
});
export type MarkMeetingOutcomeInput = z.input<typeof MarkMeetingOutcomeInput>;

/**
 * Records how the call went. A no-show queues the one "sorry we missed you,
 * rebook" email — a courtesy template, so it needs no approval — stamped so
 * the follow-up cron never sends a second.
 */
export async function markMeetingOutcome(db: Db, organisationId: string, input: MarkMeetingOutcomeInput, env: NodeJS.ProcessEnv = process.env) {
  const v = MarkMeetingOutcomeInput.parse(input);
  const now = v.now ?? new Date();
  const before = await getMeeting(db, organisationId, v.meetingId);
  if (!before) throw new MeetingRefused("not_found", "That meeting could not be found.");
  if (before.status === "cancelled") throw new MeetingRefused("not_live", "A cancelled meeting has no outcome to record.");
  const settings = await getBookingSettings(db, organisationId);
  const bookingUrl = v.outcome === "no_show" ? await rebookUrl(db, before, env) : null;

  const marked = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const alreadyEmailed = typeof before.metadata[NO_SHOW_EMAILED_AT] === "string";
    const stamp = { outcomeAt: now.toISOString(), outcomeBy: v.actorId, ...(v.outcome === "no_show" && !alreadyEmailed ? { [NO_SHOW_EMAILED_AT]: now.toISOString() } : {}) };
    const [after] = await tx.update(schema.meetings)
      .set({
        status: v.outcome, ...(v.notes !== undefined ? { notes: v.notes } : {}),
        metadata: sql`coalesce(${schema.meetings.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`, updatedAt: now,
      })
      .where(and(eq(schema.meetings.id, before.id), eq(schema.meetings.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, { actorKind: "user", actorId: v.actorId, action: `meeting.${v.outcome}`, targetType: "meeting", targetId: before.id, before, after });
    await recordActivity(tx, organisationId, {
      ...(after!.clientId ? { clientId: after!.clientId } : {}),
      actorKind: "user", actorId: v.actorId, kind: `meeting.${v.outcome}`,
      title: v.outcome === "completed" ? `Call with ${after!.guestName} completed` : `${after!.guestName} did not show for their call`,
      ...(v.notes ? { body: v.notes } : {}),
      link: `/meetings/${after!.id}`,
    });
    const notice = v.outcome === "no_show" && !alreadyEmailed && bookingUrl
      ? await queueMeetingNotice(tx, organisationId, {
          meeting: after!, notice: "no_show", subject: "Sorry we missed you — pick another time?",
          body: noShowBody(after!, settings.timezone, bookingUrl), links: { bookingUrl }, actorKind: "user", actorId: v.actorId,
        }, env)
      : null;
    return { after: after!, notice };
  });
  if (marked.notice) await emit({ name: "message.queued", organisationId, messageId: marked.notice.id });
  return { meeting: marked.after, notice: marked.notice };
}

/** Live meetings that ended more than `hours` ago and still have no outcome — the follow-up cron's list. */
export async function meetingsNeedingOutcome(db: Db, organisationId: string, options: { now?: Date; hours?: number } = {}): Promise<MeetingRow[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.hours ?? 2) * 3_600_000);
  return db.select().from(schema.meetings)
    .where(and(
      eq(schema.meetings.organisationId, organisationId), isNull(schema.meetings.deletedAt),
      inArray(schema.meetings.status, [...MEETING_LIVE_STATUSES]), lt(schema.meetings.endsAt, cutoff),
    ))
    .orderBy(asc(schema.meetings.endsAt), asc(schema.meetings.id));
}
