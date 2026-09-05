/**
 * When a month's content goes out. Pure functions, no database: the planner
 * asks for `count` moments and gets weekdays at 10:00 Europe/London spread
 * evenly across the month, so four posts land roughly weekly rather than all
 * on the 1st.
 */

const MINUTE_MS = 60_000;
export const PUBLISH_HOUR_LONDON = 10;

/** The `[year, month]` (1-based) a `YYYY-MM` key names. */
export function parsePeriodKey(periodKey: string): [number, number] {
  const [year, month] = periodKey.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error(`periodKey must be YYYY-MM, got ${periodKey}`);
  return [year, month];
}

/** Europe/London's offset from UTC, in minutes, at the given instant. 0 in winter, 60 in summer. */
export function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return Math.round((asUtc - at.getTime()) / MINUTE_MS);
}

/**
 * The instant that is `hour`:00 on the given London calendar day. Mid-morning
 * is never inside a DST transition (those happen at 01:00 UTC), so one offset
 * lookup at the UTC guess is exact.
 */
export function londonAt(year: number, month: number, day: number, hour: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * MINUTE_MS);
}

/** Every Monday-to-Friday day number in the month. */
export function weekdaysOf(periodKey: string): number[] {
  const [year, month] = parsePeriodKey(periodKey);
  const days: number[] = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= last; day += 1) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow >= 1 && dow <= 5) days.push(day);
  }
  return days;
}

/**
 * `count` publish moments across the month, in order, each at 10:00 London on
 * a weekday. The nth of `count` sits at the `n/(count+1)` point of the
 * month's weekdays — the same spread `dueWithinPeriod` gives recurring tasks —
 * so posts neither bunch at the start nor spill past the month's end. More
 * posts than weekdays simply share days.
 */
export function spreadSlotTimes(periodKey: string, count: number): Date[] {
  if (count < 1) return [];
  const [year, month] = parsePeriodKey(periodKey);
  const weekdays = weekdaysOf(periodKey);
  return Array.from({ length: count }, (_, i) => {
    const position = Math.round((weekdays.length * (i + 1)) / (count + 1));
    const index = Math.min(weekdays.length - 1, Math.max(0, position - 1));
    return londonAt(year, month, weekdays[index]!, PUBLISH_HOUR_LONDON);
  });
}
