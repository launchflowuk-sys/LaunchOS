import { describe, expect, it } from "vitest";
import { buildIcs, foldLine, icsDate, icsText } from "./ics.js";
import { DEFAULT_BOOKING_SETTINGS, bookingSettingsFrom } from "./settings.js";
import { collides, slotStartsFromSettings } from "./slots.js";
import { formatInZone, isValidTimeZone, offsetMinutes, zonedDateKey, zonedParts, zonedTimeKey, zonedTimeToUtc } from "./time.js";

describe("timezone maths", () => {
  it("converts wall-clock London times to instants across BST and GMT, and back", () => {
    // 13:00 BST on 8 Sep 2026 is 12:00Z; 13:00 GMT on 8 Dec 2026 is 13:00Z.
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 13 }, "Europe/London").toISOString()).toBe("2026-09-08T12:00:00.000Z");
    expect(zonedTimeToUtc({ year: 2026, month: 12, day: 8, hour: 13 }, "Europe/London").toISOString()).toBe("2026-12-08T13:00:00.000Z");
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 17 }, "Asia/Karachi").toISOString()).toBe("2026-09-08T12:00:00.000Z");
    const at = new Date("2026-09-08T12:00:00Z");
    expect(zonedParts(at, "Europe/London")).toMatchObject({ year: 2026, month: 9, day: 8, hour: 13, minute: 0, weekday: 2 });
    expect(offsetMinutes(at, "Europe/London")).toBe(60);
    expect(offsetMinutes(at, "Asia/Karachi")).toBe(300);
    expect(zonedDateKey(new Date("2026-09-08T23:30:00Z"), "Asia/Karachi")).toBe("2026-09-09");
    expect(zonedTimeKey(new Date("2026-09-08T23:30:00Z"), "Asia/Karachi")).toBe("04:30");
    // Across the October clock change: 01:30 on 25 Oct 2026 exists twice; we return a valid instant.
    const ambiguous = zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, "Europe/London");
    expect(zonedTimeKey(ambiguous, "Europe/London")).toBe("01:30");
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(formatInZone(at, "Europe/London")).toMatch(/Tuesday 8 September 2026.*13:00.*BST/);
    expect(formatInZone(at, "Asia/Karachi", "short")).toMatch(/Tue 8 Sept?.*17:00/);
  });
});

describe("slot generation", () => {
  it("lays out 30-minute slots inside 13:00–23:00 London Monday to Saturday and none on Sunday, clipped to the window", () => {
    // Mon 7 Sep 2026 00:00Z to Mon 14 Sep 00:00Z: six working days × 20 slots.
    const from = new Date("2026-09-07T00:00:00Z");
    const to = new Date("2026-09-14T00:00:00Z");
    const slots = slotStartsFromSettings(DEFAULT_BOOKING_SETTINGS, from, to);
    expect(slots).toHaveLength(120);
    expect(slots[0]!.toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(slots[19]!.toISOString()).toBe("2026-09-07T21:30:00.000Z");
    expect(slots.some((s) => zonedParts(s, "Europe/London").weekday === 0)).toBe(false);
    // A window that starts mid-day only returns what is after it.
    const late = slotStartsFromSettings(DEFAULT_BOOKING_SETTINGS, new Date("2026-09-07T20:15:00Z"), new Date("2026-09-08T00:00:00Z"));
    expect(late.map((s) => s.toISOString())).toEqual(["2026-09-07T20:30:00.000Z", "2026-09-07T21:00:00.000Z", "2026-09-07T21:30:00.000Z"]);
  });

  it("applies the buffer on both sides of a booking", () => {
    const busy = [{ start: Date.parse("2026-09-07T14:00:00Z"), end: Date.parse("2026-09-07T14:30:00Z") }];
    const slot = 30 * 60_000;
    const buffer = 15 * 60_000;
    expect(collides(Date.parse("2026-09-07T13:00:00Z"), slot, busy, buffer)).toBe(false);
    expect(collides(Date.parse("2026-09-07T13:30:00Z"), slot, busy, buffer)).toBe(true); // ends 14:00, inside the 15-min buffer
    expect(collides(Date.parse("2026-09-07T14:00:00Z"), slot, busy, buffer)).toBe(true);
    expect(collides(Date.parse("2026-09-07T14:30:00Z"), slot, busy, buffer)).toBe(true); // starts inside the buffer
    expect(collides(Date.parse("2026-09-07T15:00:00Z"), slot, busy, buffer)).toBe(false);
  });

  it("reads settings from organisation metadata with defaults, and falls back on a corrupt value", () => {
    expect(bookingSettingsFrom(undefined)).toEqual(DEFAULT_BOOKING_SETTINGS);
    expect(bookingSettingsFrom({ booking: { slotMinutes: 45, hours: { sun: [["10:00", "12:00"]] } } })).toMatchObject({
      slotMinutes: 45, bufferMinutes: 15, hours: { sun: [["10:00", "12:00"]], mon: [] },
    });
    expect(bookingSettingsFrom({ booking: { slotMinutes: "lots" } })).toEqual(DEFAULT_BOOKING_SETTINGS);
    expect(bookingSettingsFrom({ booking: { hours: { mon: [["23:00", "13:00"]] } } })).toEqual(DEFAULT_BOOKING_SETTINGS);
  });
});

describe("ics", () => {
  it("builds a UTC REQUEST with escaped text, folded lines and a climbing sequence", () => {
    const ics = buildIcs({
      uid: "m1@launchos", method: "REQUEST", sequence: 2,
      startsAt: new Date("2026-09-08T12:00:00Z"), endsAt: new Date("2026-09-08T12:30:00Z"),
      summary: "LaunchFlow call; with Shoji", description: "Join: https://zoom.test/j/1\nBring, questions",
      location: "https://zoom.test/j/1", url: "https://zoom.test/j/1",
      organiser: { name: "Shoji", email: "hello@launchflow.test" }, attendee: { name: "Aisha", email: "aisha@example.test" },
      stamp: new Date("2026-09-01T00:00:00Z"),
    });
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("METHOD:REQUEST\r\n");
    expect(ics).toContain("DTSTART:20260908T120000Z\r\n");
    expect(ics).toContain("DTEND:20260908T123000Z\r\n");
    expect(ics).toContain("SEQUENCE:2\r\n");
    expect(ics).toContain("SUMMARY:LaunchFlow call\\; with Shoji\r\n");
    expect(ics).toContain("DESCRIPTION:Join: https://zoom.test/j/1\\nBring\\, questions\r\n");
    expect(ics).toContain("STATUS:CONFIRMED\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(icsDate(new Date("2026-09-08T12:00:00.123Z"))).toBe("20260908T120000Z");
    expect(icsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    const long = foldLine(`DESCRIPTION:${"x".repeat(200)}`);
    expect(long.split("\r\n").every((line, i) => Buffer.byteLength(line) <= 75 && (i === 0 || line.startsWith(" ")))).toBe(true);
    expect(buildIcs({
      uid: "m1@launchos", method: "CANCEL", sequence: 3, startsAt: new Date(), endsAt: new Date(), summary: "x",
      organiser: { name: "S", email: "s@t.test" }, attendee: { name: "A", email: "a@t.test" },
    })).toContain("STATUS:CANCELLED");
  });
});
