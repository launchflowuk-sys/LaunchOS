import { describe, expect, it } from "vitest";
import { dateKeyIn, dayLabel, dayStrip, formatInZone, groupSlotsByDay, longDayLabel, nextDayKey, timeIn, zoneCity, zoneLabel } from "./slot-days";

// 8 Sep 2026 12:00 UTC: 13:00 BST in London, 17:00 PKT in Karachi, 08:00 EDT in New York.
const NOON_UTC = new Date("2026-09-08T12:00:00.000Z");

describe("slot-days", () => {
  it("keys and labels an instant in the visitor's zone", () => {
    expect(dateKeyIn(NOON_UTC, "Europe/London")).toBe("2026-09-08");
    expect(timeIn(NOON_UTC, "Europe/London")).toBe("13:00");
    expect(timeIn(NOON_UTC, "Asia/Karachi")).toBe("17:00");
    expect(timeIn(NOON_UTC, "America/New_York")).toBe("08:00");
    // 22:30 BST is the next calendar day in Karachi.
    const late = new Date("2026-09-08T21:30:00.000Z");
    expect(dateKeyIn(late, "Europe/London")).toBe("2026-09-08");
    expect(dateKeyIn(late, "Asia/Karachi")).toBe("2026-09-09");
    expect(timeIn(late, "Asia/Karachi")).toBe("02:30");
    expect(zoneLabel(NOON_UTC, "Europe/London")).toBe("BST");
    expect(zoneCity("America/New_York")).toBe("New York");
  });

  it("labels a day key without a zone, so the strip never rolls over a day edge", () => {
    expect(dayLabel("2026-09-08")).toEqual({ weekday: "Tue", day: "8", month: "Sept" });
    expect(longDayLabel("2026-09-08")).toBe("Tuesday 8 September");
    expect(nextDayKey("2026-09-30")).toBe("2026-10-01");
  });

  it("formats an instant the way a card reads it", () => {
    expect(formatInZone(NOON_UTC, "Europe/London")).toBe("Tuesday 8 September 2026, 13:00 BST");
    expect(formatInZone(NOON_UTC, "Europe/London", "short")).toBe("Tue 8 Sept, 13:00 BST");
  });

  it("builds the day strip from the window in the visitor's zone, closed days included", () => {
    const from = new Date("2026-09-08T12:00:00.000Z");
    const to = new Date("2026-09-11T22:30:00.000Z");
    // 23:30 BST on the 11th; 18:30 EDT on the 11th; 03:30 PKT on the 12th.
    expect(dayStrip(from, to, "Europe/London")).toEqual(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]);
    expect(dayStrip(from, to, "America/New_York")).toEqual(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]);
    expect(dayStrip(from, to, "Asia/Karachi")).toEqual(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"]);
    expect(dayStrip(from, new Date("2030-01-01T00:00:00.000Z"), "UTC", 5)).toHaveLength(5);
  });

  it("groups slots by the visitor's day and labels each with its local time, in order", () => {
    const slots = [
      { startsAt: "2026-09-08T21:30:00.000Z", endsAt: "2026-09-08T22:00:00.000Z", hostTime: "22:30", hostDate: "2026-09-08" },
      { startsAt: "2026-09-08T12:00:00.000Z", endsAt: "2026-09-08T12:30:00.000Z", hostTime: "13:00", hostDate: "2026-09-08" },
      { startsAt: "not-a-date", endsAt: "", hostTime: "", hostDate: "" },
    ];
    const london = groupSlotsByDay(slots, "Europe/London");
    expect([...london.keys()]).toEqual(["2026-09-08"]);
    expect(london.get("2026-09-08")?.map((s) => s.time)).toEqual(["13:00", "22:30"]);

    const karachi = groupSlotsByDay(slots, "Asia/Karachi");
    expect([...karachi.keys()]).toEqual(["2026-09-08", "2026-09-09"]);
    expect(karachi.get("2026-09-09")?.[0]).toMatchObject({ time: "02:30", slot: { hostTime: "22:30" } });
  });
});
