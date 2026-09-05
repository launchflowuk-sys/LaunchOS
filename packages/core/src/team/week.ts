import { londonAt } from "../content/schedule.js";
import { londonDateKey } from "../tasks/dates.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type IsoDate = string;

/** `YYYY-MM-DD` as a calendar day; parsed as UTC noon so no zone can shift the date. */
function dayOf(key: IsoDate): Date {
  return new Date(`${key}T12:00:00Z`);
}

function keyOf(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week holding `key`, as a calendar day. */
export function mondayOf(key: IsoDate): IsoDate {
  const day = dayOf(key);
  const offset = (day.getUTCDay() + 6) % 7;
  return keyOf(new Date(day.getTime() - offset * DAY_MS));
}

/** `key` plus `days`, as a calendar day. */
export function addCalendarDays(key: IsoDate, days: number): IsoDate {
  return keyOf(new Date(dayOf(key).getTime() + days * DAY_MS));
}

/** Midnight at the start of the London calendar day. */
export function londonDayStart(key: IsoDate): Date {
  const [year, month, day] = key.split("-").map(Number);
  return londonAt(year!, month!, day!, 0);
}

export interface WeekBounds {
  /** The Monday, as a calendar day. */
  weekStart: IsoDate;
  /** The following Monday, as a calendar day — exclusive. */
  weekEnd: IsoDate;
  /** The seven calendar days, Monday first. */
  days: IsoDate[];
  /** Instants: [start, end) in Europe/London. */
  start: Date;
  end: Date;
}

/** The week — Monday to Sunday, in Europe/London — holding `key`. Any day of the week snaps to its Monday. */
export function weekBounds(key: IsoDate): WeekBounds {
  const weekStart = mondayOf(key);
  const weekEnd = addCalendarDays(weekStart, 7);
  const days = Array.from({ length: 7 }, (_, i) => addCalendarDays(weekStart, i));
  return { weekStart, weekEnd, days, start: londonDayStart(weekStart), end: londonDayStart(weekEnd) };
}

/** The London calendar day an instant falls on. */
export function londonDayOf(at: Date): IsoDate {
  return londonDateKey(at);
}

/**
 * Whole minutes between the start of an entry and its end — or `now` while it
 * is still running. Never negative: a clock skewed the wrong way reads as
 * zero, not as time owed.
 */
export function entryMinutes(entry: { startedAt: Date; endedAt: Date | null }, now: Date): number {
  const end = entry.endedAt ?? now;
  return Math.max(0, Math.floor((end.getTime() - entry.startedAt.getTime()) / MINUTE_MS));
}

/** Minutes as `7h 35m`, the way a timesheet cell reads. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
