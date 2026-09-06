import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { MEETING_LIVE_STATUSES } from "@launchos/db/schema";
import { resolveBookingHost, DAY_KEYS, type BookingSettings } from "./settings.js";
import { addDaysToKey, isValidTimeZone, keyOfParts, zonedDateKey, zonedParts, zonedTimeKey, zonedTimeToUtc } from "./time.js";

export const AvailableSlotsInput = z.object({
  /** Inclusive start of the window asked for; clamped to now + minimum notice. */
  from: z.date().optional(),
  /** Exclusive end; clamped to now + horizon. */
  to: z.date().optional(),
  /** The visitor's browser zone — every slot is labelled in it. */
  guestTimezone: z.string().refine(isValidTimeZone, "not an IANA timezone").default("Europe/London"),
  /** A meeting being moved does not block its own new slot. */
  excludeMeetingId: z.string().uuid().optional(),
  now: z.date().optional(),
});
export type AvailableSlotsInput = z.input<typeof AvailableSlotsInput>;

export interface Slot {
  /** ISO instant, UTC — what `bookMeeting` takes as `startsAt`. */
  startsAt: string;
  endsAt: string;
  /** `YYYY-MM-DD` and `HH:MM` in the guest's zone — what the page groups and shows. */
  guestDate: string;
  guestTime: string;
  /** The same in the host's zone — shown small as "Shoji's time". */
  hostDate: string;
  hostTime: string;
}

export interface AvailableSlotsResult {
  timezone: { guest: string; host: string };
  slotMinutes: number;
  /** The window actually searched, after clamping. */
  from: string;
  to: string;
  slots: Slot[];
}

interface Busy { start: number; end: number }

/**
 * Every start time inside the host's hours between `from` and `to`, in the
 * host's zone — pure, so it can be tested without a database. A window's
 * last slot ends on or before the window's end; the buffer sits *between*
 * meetings, not inside a window, so it is applied against bookings below.
 */
export function slotStartsFromSettings(settings: BookingSettings, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const step = settings.slotMinutes * 60_000;
  const firstKey = zonedDateKey(from, settings.timezone);
  const lastKey = zonedDateKey(to, settings.timezone);
  let key = firstKey;
  // A hard cap on the walk so a corrupt window can never spin: horizon is ≤ 90 days.
  for (let i = 0; i <= 92 && key <= lastKey; i++) {
    const parts = addDaysToKey(key, 0);
    const probe = zonedTimeToUtc({ ...parts, hour: 12 }, settings.timezone);
    const dayKey = DAY_KEYS[(zonedParts(probe, settings.timezone).weekday + 6) % 7]!;
    for (const [open, close] of settings.hours[dayKey]) {
      const [oh, om] = open.split(":").map(Number) as [number, number];
      const [ch, cm] = close.split(":").map(Number) as [number, number];
      const windowStart = zonedTimeToUtc({ ...parts, hour: oh, minute: om }, settings.timezone).getTime();
      const windowEnd = zonedTimeToUtc({ ...parts, hour: ch, minute: cm }, settings.timezone).getTime();
      for (let t = windowStart; t + step <= windowEnd; t += step) {
        if (t >= from.getTime() && t < to.getTime()) out.push(new Date(t));
      }
    }
    key = keyOfParts(addDaysToKey(key, 1));
  }
  return out;
}

/** True when a slot `[start, start+slot)` collides with any busy interval once the buffer is applied on both sides. */
export function collides(start: number, slotMs: number, busy: readonly Busy[], bufferMs: number): boolean {
  const end = start + slotMs;
  return busy.some((b) => start < b.end + bufferMs && end > b.start - bufferMs);
}

/**
 * The slots a guest may book: the host's hours, minus the minimum notice,
 * minus every live meeting in the host's diary (with the buffer either side),
 * inside the horizon. Each slot is labelled in the guest's zone and the
 * host's. Nothing here is per-guest, so the answer may be cached briefly by
 * the page; `bookMeeting` re-checks under the unique index anyway.
 */
export async function availableSlots(db: Db, organisationId: string, input: AvailableSlotsInput = {}): Promise<AvailableSlotsResult> {
  const v = AvailableSlotsInput.parse(input);
  const { settings, hostUserId } = await resolveBookingHost(db, organisationId);
  const now = v.now ?? new Date();
  const earliest = new Date(now.getTime() + settings.minNoticeHours * 3_600_000);
  const latest = new Date(now.getTime() + settings.horizonDays * 86_400_000);
  const from = new Date(Math.max(earliest.getTime(), v.from?.getTime() ?? earliest.getTime()));
  const to = new Date(Math.min(latest.getTime(), v.to?.getTime() ?? latest.getTime()));
  if (from >= to) {
    return { timezone: { guest: v.guestTimezone, host: settings.timezone }, slotMinutes: settings.slotMinutes, from: from.toISOString(), to: to.toISOString(), slots: [] };
  }

  const bufferMs = settings.bufferMinutes * 60_000;
  const slotMs = settings.slotMinutes * 60_000;
  // Any live meeting whose buffered span could touch the window. The host's
  // diary is the host's, across organisations they belong to — a slot is
  // busy whoever booked it.
  const busyRows = await db
    .select({ start: schema.meetings.startsAt, end: schema.meetings.endsAt })
    .from(schema.meetings)
    .where(and(
      eq(schema.meetings.hostUserId, hostUserId),
      inArray(schema.meetings.status, [...MEETING_LIVE_STATUSES]),
      gte(schema.meetings.endsAt, new Date(from.getTime() - bufferMs)),
      lte(schema.meetings.startsAt, new Date(to.getTime() + bufferMs)),
      v.excludeMeetingId ? ne(schema.meetings.id, v.excludeMeetingId) : undefined,
    ));
  const busy: Busy[] = busyRows.map((r) => ({ start: r.start.getTime(), end: r.end.getTime() }));

  const slots = slotStartsFromSettings(settings, from, to)
    .filter((start) => !collides(start.getTime(), slotMs, busy, bufferMs))
    .map((start): Slot => {
      const end = new Date(start.getTime() + slotMs);
      return {
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        guestDate: zonedDateKey(start, v.guestTimezone),
        guestTime: zonedTimeKey(start, v.guestTimezone),
        hostDate: zonedDateKey(start, settings.timezone),
        hostTime: zonedTimeKey(start, settings.timezone),
      };
    });

  return {
    timezone: { guest: v.guestTimezone, host: settings.timezone },
    slotMinutes: settings.slotMinutes,
    from: from.toISOString(),
    to: to.toISOString(),
    slots,
  };
}

/** Whether one instant is a bookable start right now — what `bookMeeting` checks before touching the provider. */
export async function isSlotAvailable(db: Db, organisationId: string, startsAt: Date, options: { now?: Date; excludeMeetingId?: string } = {}): Promise<boolean> {
  const { settings } = await resolveBookingHost(db, organisationId);
  const to = new Date(startsAt.getTime() + settings.slotMinutes * 60_000 + 1);
  const result = await availableSlots(db, organisationId, {
    from: startsAt, to, now: options.now ?? new Date(),
    ...(options.excludeMeetingId ? { excludeMeetingId: options.excludeMeetingId } : {}),
  });
  return result.slots.some((s) => s.startsAt === startsAt.toISOString());
}
