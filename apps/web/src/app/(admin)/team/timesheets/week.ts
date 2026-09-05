import { addCalendarDays, londonDayOf, londonDayStart, mondayOf } from "@launchos/core";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Monday the `?week=` parameter means. Any day of a week snaps to its
 * Monday (core's `mondayOf`), so a link may carry any date; anything that is
 * not a date at all reads as this week, in London.
 */
export function weekFromParam(value: string | string[] | undefined, now = new Date()): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw && ISO_DAY.test(raw) && !Number.isNaN(Date.parse(raw))) return mondayOf(raw);
  return mondayOf(londonDayOf(now));
}

const DAY_SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "Europe/London" });
const DAY_LONG = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Europe/London",
});
const DAY_FULL = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/London",
});
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/** "Mon 31" — a column heading. */
export function dayShort(key: string): string {
  return DAY_SHORT.format(londonDayStart(key));
}

/** "Monday 31 August 2026" — a day's heading in the entries list. */
export function dayFull(key: string): string {
  // ICU writes "Monday, 31 August" for en-GB; the comma is not how the day is said.
  return DAY_FULL.format(londonDayStart(key)).replace(",", "");
}

/** "Mon 31 Aug – Sun 6 Sept 2026" — the week the picker is on (ICU's en-GB short months, "Sept" included). */
export function weekLabel(weekStart: string): string {
  const sunday = addCalendarDays(weekStart, 6);
  const year = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "Europe/London" }).format(
    londonDayStart(sunday),
  );
  return `${DAY_LONG.format(londonDayStart(weekStart))} – ${DAY_LONG.format(londonDayStart(sunday))} ${year}`;
}

/** "09:15" in London, whatever machine renders it. */
export function timeOfDay(at: Date): string {
  return TIME.format(at);
}

export type WeekNav = { previous: string; next: string; thisWeek: string; isThisWeek: boolean };

export function weekNav(weekStart: string, now = new Date()): WeekNav {
  const thisWeek = mondayOf(londonDayOf(now));
  return {
    previous: addCalendarDays(weekStart, -7),
    next: addCalendarDays(weekStart, 7),
    thisWeek,
    isThisWeek: weekStart === thisWeek,
  };
}
