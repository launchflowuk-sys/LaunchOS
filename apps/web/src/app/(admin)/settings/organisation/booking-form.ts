import { type BookingSettings, BookingSettingsSchema, DAY_KEYS, type DayKey } from "@launchos/core";
import { z } from "zod";

/**
 * The Booking section's form, read back into core's `BookingSettings`.
 *
 * Beside the action rather than in it so the parsing can be tested without
 * a server-action module. Hours are two time inputs per weekday; both blank
 * is a closed day, one blank is a mistake worth a sentence, and the pair
 * must run forwards. The numbers post as strings.
 */

export const DAY_LABEL: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/**
 * The zones the select offers. Shoji's two countries first, then the ones a
 * UK agency's clients and staff are likely to be in; the current value is
 * added by the page when it is not in this list, so nothing is ever lost.
 */
export const TIMEZONE_CHOICES: readonly string[] = [
  "Europe/London",
  "Asia/Karachi",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Singapore",
  "Australia/Sydney",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "UTC",
];

const Time = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 13:00");
const WholeNumber = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => /^\d+$/.test(v), `${label} must be a whole number`)
    .transform(Number)
    .pipe(z.number().int().min(min, `${label} must be at least ${min}`).max(max, `${label} must be at most ${max}`));

export const BookingFormSchema = z.object({
  timezone: z.string().trim().min(1, "Choose a time zone").max(80),
  slotMinutes: WholeNumber("Slot length", 10, 240),
  bufferMinutes: WholeNumber("Buffer", 0, 120),
  minNoticeHours: WholeNumber("Minimum notice", 0, 168),
  horizonDays: WholeNumber("Horizon", 1, 90),
  /** A member's user id, or blank for "the owner". */
  hostUserId: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : null)),
});

export type BookingFormRead = { status: "ok"; settings: Partial<BookingSettings> } | { status: "error"; message: string };

/** Field names: `mon_from` / `mon_to`, and so on. */
export function hoursFieldNames(day: DayKey): { from: string; to: string } {
  return { from: `${day}_from`, to: `${day}_to` };
}

function readString(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw.trim() : "";
}

/** Reads the whole Booking form, refusing a body that does not add up rather than half-saving it. */
export function readBookingForm(formData: FormData): BookingFormRead {
  const parsed = BookingFormSchema.safeParse({
    timezone: readString(formData, "timezone"),
    slotMinutes: readString(formData, "slotMinutes"),
    bufferMinutes: readString(formData, "bufferMinutes"),
    minNoticeHours: readString(formData, "minNoticeHours"),
    horizonDays: readString(formData, "horizonDays"),
    hostUserId: readString(formData, "hostUserId"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form and try again" };

  const hours = {} as BookingSettings["hours"];
  for (const day of DAY_KEYS) {
    const names = hoursFieldNames(day);
    const from = readString(formData, names.from);
    const to = readString(formData, names.to);
    if (from.length === 0 && to.length === 0) {
      hours[day] = [];
      continue;
    }
    if (from.length === 0 || to.length === 0) {
      return { status: "error", message: `${DAY_LABEL[day]}: enter both an opening and a closing time, or leave both blank to close the day.` };
    }
    const fromOk = Time.safeParse(from);
    const toOk = Time.safeParse(to);
    if (!fromOk.success || !toOk.success) return { status: "error", message: `${DAY_LABEL[day]}: use HH:MM, e.g. 13:00.` };
    if (!(fromOk.data < toOk.data)) return { status: "error", message: `${DAY_LABEL[day]}: the closing time must be after the opening time.` };
    hours[day] = [[fromOk.data, toOk.data]];
  }

  // Core's own schema last, so an invalid time zone is a sentence here too.
  const settings = BookingSettingsSchema.safeParse({ ...parsed.data, hours });
  if (!settings.success) return { status: "error", message: settings.error.issues[0]?.message ?? "Check the form and try again" };
  return { status: "ok", settings: settings.data };
}

/** The first window of a day as the two inputs show it; blank when closed. Only the first window is edited here. */
export function hoursDefaults(hours: BookingSettings["hours"], day: DayKey): { from: string; to: string } {
  const first = hours[day][0];
  return first ? { from: first[0], to: first[1] } : { from: "", to: "" };
}
