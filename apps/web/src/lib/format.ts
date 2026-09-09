const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/London",
});

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
}

const CURRENCY_CODE = /^[A-Z]{3}$/;
const MONEY_FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Pence to a money string that can never throw.
 *
 * `Intl.NumberFormat` raises `RangeError` for a currency that is not a
 * well-formed ISO-4217 code, and a listing page formats every row it renders —
 * so one bad value in one row would 500 the whole screen for everyone, with no
 * way to reach an edit form to fix it. Core refuses to write such a code now;
 * this is the second line, for rows written before that guard existed and for
 * anything a future import lets through. The fallback is honest rather than
 * pretty: the code as stored, then the amount.
 */
export function formatMoney(pence: number, currency: string): string {
  const amount = pence / 100;
  const code = currency.trim().toUpperCase();
  if (CURRENCY_CODE.test(code)) {
    const cached = MONEY_FORMATTERS.get(code);
    if (cached) return cached.format(amount);
    try {
      const formatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: code });
      MONEY_FORMATTERS.set(code, formatter);
      return formatter.format(amount);
    } catch {
      // An ICU build that rejects a code this regex accepts: fall through.
    }
  }
  return `${code || "?"} ${amount.toFixed(2)}`;
}

/** Pence to a UK currency string. Money is stored as integer pence everywhere. */
export function formatPence(pence: number, currency = "GBP"): string {
  return formatMoney(pence, currency);
}

const DATE_ONLY = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Europe/London" });

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_ONLY.format(date);
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Minutes as `7h 35m`, the way a timesheet cell and the top-bar clock read.
 * The same rule as core's `formatMinutes`, kept here so a client component can
 * use it without pulling `@launchos/core` — and its Postgres driver — into the
 * browser bundle.
 */
export function formatDuration(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
