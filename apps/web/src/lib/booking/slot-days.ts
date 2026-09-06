/**
 * Grouping and labelling booking slots in a time zone, with `Intl` only.
 *
 * A leaf module: it runs in the browser (the slot picker groups the slots in
 * the visitor's own zone once it knows it) and on the server (the done page
 * and the admin screens label a meeting in London time), and core's
 * `meetings/time.ts` cannot be imported into a client component without
 * dragging the Postgres driver behind it.
 */

/** A slot as the page receives it from core's `availableSlots`, serialised. */
export type SlotView = {
  /** ISO instant, UTC. */
  startsAt: string;
  endsAt: string;
  /** `HH:MM` in the host's zone — shown small beside the visitor's time. */
  hostTime: string;
  hostDate: string;
};

const HOST_FALLBACK_ZONE = "Europe/London";

/** The browser's zone, or London when the runtime will not say. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : HOST_FALLBACK_ZONE;
  } catch {
    return HOST_FALLBACK_ZONE;
  }
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) if (part.type !== "literal") out[part.type] = part.value;
  return out;
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function dateKeyIn(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:MM` of an instant in a zone. `24:00` (an ICU quirk at midnight) reads as `00:00`. */
export function timeIn(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** "BST", "PKT", "GMT+5" — the short name of a zone at an instant. */
export function zoneLabel(date: Date, timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Europe/London" → "London"; "America/New_York" → "New York". */
export function zoneCity(timeZone: string): string {
  const last = timeZone.split("/").at(-1) ?? timeZone;
  return last.replaceAll("_", " ");
}

/** The calendar parts of a `YYYY-MM-DD` key, as a UTC-noon instant so a day label never rolls over a zone edge. */
function keyToNoonUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

/** "Tue 8 Sep" for a day key. Zone-free by construction. */
export function dayLabel(dateKey: string): { weekday: string; day: string; month: string } {
  const at = keyToNoonUtc(dateKey);
  const f = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(at);
  return { weekday: f({ weekday: "short" }), day: f({ day: "numeric" }), month: f({ month: "short" }) };
}

/** "Tuesday 8 September" for a day key. */
export function longDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(keyToNoonUtc(dateKey));
}

/** "Tuesday 8 September 2026, 13:00 BST" — an instant in a zone, as a card reads it. */
export function formatInZone(date: Date, timeZone: string, style: "long" | "short" = "long"): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    ...(style === "long"
      ? { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }
      : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
  });
  return f.format(date).replace(/^([A-Za-z]+),/, "$1").replace(/,? at /, ", ");
}

/** The next day key after `dateKey`, in the calendar. */
export function nextDayKey(dateKey: string): string {
  const at = keyToNoonUtc(dateKey);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/**
 * Every calendar day from `from` up to and including the day `to` falls on,
 * in the visitor's zone — the strip the page shows, empty days included so a
 * closed Sunday reads as closed rather than vanishing. Capped so a bad pair
 * of instants cannot make a strip of thousands.
 */
export function dayStrip(from: Date, to: Date, timeZone: string, maxDays = 60): string[] {
  const first = dateKeyIn(from, timeZone);
  const last = dateKeyIn(to, timeZone);
  const days: string[] = [];
  let key = first;
  while (key <= last && days.length < maxDays) {
    days.push(key);
    key = nextDayKey(key);
  }
  return days;
}

export type DaySlots = { dateKey: string; slots: { slot: SlotView; time: string }[] };

/** Slots grouped by the visitor's calendar day, each labelled with its `HH:MM` in that zone, in order. */
export function groupSlotsByDay(slots: readonly SlotView[], timeZone: string): Map<string, DaySlots["slots"]> {
  const groups = new Map<string, DaySlots["slots"]>();
  const sorted = [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const slot of sorted) {
    const at = new Date(slot.startsAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dateKeyIn(at, timeZone);
    const list = groups.get(key) ?? [];
    list.push({ slot, time: timeIn(at, timeZone) });
    groups.set(key, list);
  }
  return groups;
}
