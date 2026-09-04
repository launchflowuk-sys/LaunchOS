import type { TaskRecurrence } from "@launchos/db/schema";

const DAY_MS = 86_400_000;

/** A new Date `days` later. Never mutates its argument. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export type Period = { key: string; start: Date; end: Date };

/**
 * The period a recurring template falls in right now, as a half-open range
 * [start, end). Bounds are computed in UTC: Europe/London is at most one hour
 * off UTC, which cannot move a day-granularity due date across a period.
 * `none` never reaches generation but is mapped to the month so the function
 * is total.
 */
export function periodBounds(recurrence: TaskRecurrence, now: Date): Period {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (recurrence === "quarterly") {
    const quarter = Math.floor(month / 3);
    return {
      key: `${year}-Q${quarter + 1}`,
      start: new Date(Date.UTC(year, quarter * 3, 1)),
      end: new Date(Date.UTC(year, quarter * 3 + 3, 1)),
    };
  }

  if (recurrence === "weekly") {
    // Monday-based week; the key carries the Monday so it sorts and reads well.
    const mondayOffset = (now.getUTCDay() + 6) % 7;
    const start = new Date(Date.UTC(year, month, now.getUTCDate() - mondayOffset));
    return { key: `${year}-W-${start.toISOString().slice(0, 10)}`, start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }

  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/**
 * Due date for the nth of `quantity` tasks in a period, spread evenly so four
 * social posts land roughly weekly rather than all on the 1st.
 */
export function dueWithinPeriod(period: Period, n: number, quantity: number): Date {
  const span = period.end.getTime() - period.start.getTime();
  return new Date(period.start.getTime() + Math.round((span * n) / (quantity + 1)));
}

/** `YYYY-MM-DD` in Europe/London — the once-per-day notification key. */
export function londonDateKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
