import { londonOffsetMinutes } from "@launchos/core";

/**
 * `<input type="datetime-local">` carries no time zone: it posts
 * `2026-09-12T10:00` and shows whatever it is given. Content goes out on
 * Europe/London time whatever machine Shoji is on, so both directions convert
 * against London, not the browser or the server.
 */
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `2026-09-12T10:00` read as London wall-clock time → the instant. */
export function londonInputToDate(value: string): Date | undefined {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return undefined;
  // Take the wall-clock reading as if it were UTC, then shift it by London's
  // offset at that moment. `londonOffsetMinutes` is evaluated on the
  // provisional instant, which is only wrong for the one repeated hour when
  // the clocks go back, and there it still yields a valid time that day.
  const provisional = new Date(`${match[0]}:00.000Z`);
  if (Number.isNaN(provisional.getTime())) return undefined;
  const offset = londonOffsetMinutes(provisional);
  return new Date(provisional.getTime() - offset * 60_000);
}

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The instant → `2026-09-12T10:00` in London, the shape the input wants back. */
export function dateToLondonInput(value: Date | null | undefined): string {
  if (!value || Number.isNaN(value.getTime())) return "";
  const parts = Object.fromEntries(PARTS.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}
