/**
 * Timezone arithmetic on `Intl.DateTimeFormat` alone — no date library. Two
 * operations cover everything the booking page needs: "what wall-clock time
 * is this instant in zone Z" and "what instant is this wall-clock time in
 * zone Z". The second is the one `Date` cannot do; it is solved by guessing
 * with the UTC offset at that instant and correcting once, which is exact
 * except inside a DST gap, where the wall-clock time does not exist and the
 * later interpretation is returned.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the zone. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]),
    hour: Number(parts["hour"]) % 24, minute: Number(parts["minute"]), second: Number(parts["second"]),
    weekday: WEEKDAYS[parts["weekday"] ?? "Sun"] ?? 0,
  };
}

/** The zone's UTC offset at `date`, in minutes (London in summer = 60). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The instant at which `timeZone`'s wall clock reads the given parts. */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, 0);
  const guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  // One correction handles a DST boundary between the naive instant and the guess.
  const corrected = new Date(naive - offsetMinutes(guess, timeZone) * 60_000);
  return corrected;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** `HH:MM` of `date` in `timeZone`. */
export function zonedTimeKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** The calendar day `days` after `YYYY-MM-DD`, as parts. Pure calendar arithmetic. */
export function addDaysToKey(dateKey: string, days: number): { year: number; month: number; day: number } {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function keyOfParts(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** "Tue 15 Sep, 14:30 BST" — how a slot reads in an email or on a card. */
export function formatInZone(date: Date, timeZone: string, style: "long" | "short" = "long"): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23",
    ...(style === "long"
      ? { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }
      : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
  });
  // "Tuesday, 8 September 2026 at 13:00 BST" → "Tuesday 8 September 2026, 13:00 BST".
  return f.format(date).replace(/^([A-Za-z]+),/, "$1").replace(/,? at /, ", ");
}

/** The short label for a zone: "BST", "PKT", "GMT+5". */
export function zoneAbbreviation(date: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}
