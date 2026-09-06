import { DEFAULT_BOOKING_SETTINGS } from "@launchos/core";
import { describe, expect, it } from "vitest";
import { hoursDefaults, readBookingForm } from "./booking-form";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const BASE = {
  timezone: "Europe/London",
  slotMinutes: "30",
  bufferMinutes: "15",
  minNoticeHours: "12",
  horizonDays: "21",
  hostUserId: "",
  mon_from: "13:00", mon_to: "23:00",
  tue_from: "13:00", tue_to: "23:00",
  wed_from: "13:00", wed_to: "23:00",
  thu_from: "13:00", thu_to: "23:00",
  fri_from: "13:00", fri_to: "23:00",
  sat_from: "13:00", sat_to: "23:00",
  sun_from: "", sun_to: "",
};

describe("readBookingForm", () => {
  it("reads the defaults back as core's settings, a blank pair as a closed day and a blank host as the owner", () => {
    const read = readBookingForm(form(BASE));
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.settings).toEqual({ ...DEFAULT_BOOKING_SETTINGS, hostUserId: null });
    expect(read.settings.hours?.sun).toEqual([]);
  });

  it("keeps the host member and Shoji's Karachi hours", () => {
    const read = readBookingForm(form({ ...BASE, timezone: "Asia/Karachi", hostUserId: "user_1", mon_from: "17:00", mon_to: "23:30", sun_from: "10:00", sun_to: "12:00" }));
    expect(read).toMatchObject({ status: "ok", settings: { timezone: "Asia/Karachi", hostUserId: "user_1", hours: { mon: [["17:00", "23:30"]], sun: [["10:00", "12:00"]] } } });
  });

  it("refuses half a pair, a backwards pair, a bad time and a bad zone with a sentence naming the field", () => {
    expect(readBookingForm(form({ ...BASE, wed_to: "" }))).toEqual({ status: "error", message: "Wednesday: enter both an opening and a closing time, or leave both blank to close the day." });
    expect(readBookingForm(form({ ...BASE, fri_from: "20:00", fri_to: "09:00" }))).toEqual({ status: "error", message: "Friday: the closing time must be after the opening time." });
    expect(readBookingForm(form({ ...BASE, sat_from: "1pm" }))).toEqual({ status: "error", message: "Saturday: use HH:MM, e.g. 13:00." });
    expect(readBookingForm(form({ ...BASE, timezone: "Mars/Olympus" }))).toMatchObject({ status: "error", message: "not an IANA timezone" });
  });

  it("refuses numbers outside core's bounds and non-numbers", () => {
    expect(readBookingForm(form({ ...BASE, slotMinutes: "5" }))).toEqual({ status: "error", message: "Slot length must be at least 10" });
    expect(readBookingForm(form({ ...BASE, horizonDays: "365" }))).toEqual({ status: "error", message: "Horizon must be at most 90" });
    expect(readBookingForm(form({ ...BASE, bufferMinutes: "ten" }))).toEqual({ status: "error", message: "Buffer must be a whole number" });
    expect(readBookingForm(form({ ...BASE, minNoticeHours: "" }))).toEqual({ status: "error", message: "Minimum notice is required" });
  });

  it("shows the first window of a day in the two inputs, blank when closed", () => {
    expect(hoursDefaults(DEFAULT_BOOKING_SETTINGS.hours, "mon")).toEqual({ from: "13:00", to: "23:00" });
    expect(hoursDefaults(DEFAULT_BOOKING_SETTINGS.hours, "sun")).toEqual({ from: "", to: "" });
  });
});
