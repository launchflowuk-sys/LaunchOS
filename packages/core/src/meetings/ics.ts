/**
 * A minimal iCalendar builder for one meeting. UTC throughout (`DTSTART` in
 * `Z` form, no `VTIMEZONE`), which every calendar client renders in the
 * viewer's own zone. `METHOD:REQUEST` for a booking or a move,
 * `METHOD:CANCEL` for a cancellation; `SEQUENCE` climbs on every change so a
 * client replaces rather than duplicates the event.
 */

export interface IcsEventInput {
  /** Stable across the event's life — the meeting id. */
  uid: string;
  method: "REQUEST" | "CANCEL";
  sequence: number;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string | undefined;
  /** The join URL. */
  location?: string | undefined;
  url?: string | undefined;
  organiser: { name: string; email: string };
  attendee: { name: string; email: string };
  /** Defaults to now. */
  stamp?: Date | undefined;
}

/** `20260915T133000Z` */
export function icsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545 text: backslash, semicolon, comma and newline escaped. */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets are folded with CRLF + one space. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte character.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

export function buildIcs(input: IcsEventInput): string {
  const stamp = input.stamp ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LaunchFlow//LaunchOS//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${icsText(input.uid)}`,
    `DTSTAMP:${icsDate(stamp)}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTART:${icsDate(input.startsAt)}`,
    `DTEND:${icsDate(input.endsAt)}`,
    `SUMMARY:${icsText(input.summary)}`,
    ...(input.description ? [`DESCRIPTION:${icsText(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${icsText(input.location)}`] : []),
    ...(input.url ? [`URL:${icsText(input.url)}`] : []),
    `ORGANIZER;CN=${icsText(input.organiser.name)}:mailto:${input.organiser.email}`,
    `ATTENDEE;CN=${icsText(input.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${input.attendee.email}`,
    `STATUS:${input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
