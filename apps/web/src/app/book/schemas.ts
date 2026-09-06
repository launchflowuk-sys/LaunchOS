import { z } from "zod";
import { isValidTimeZone } from "@/lib/booking/slot-days";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The booking page's contract, beside the actions rather than in them so a
 * test can import the schemas and the limiter without a server-action module.
 */

/** A failure is a sentence on the form; success is a redirect, so it never returns. `refresh` asks the page to re-read its slots. */
export type BookingActionResult = { status: "error"; message: string; refresh?: boolean };

const IsoInstant = z
  .string()
  .trim()
  .min(1, "Pick a time")
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Pick a time")
  .transform((v) => new Date(v));

const TimeZone = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((v) => (v && isValidTimeZone(v) ? v : "Europe/London"));

/** Bounds mirror core's `BookMeetingInput` so a refusal is a sentence here, not a thrown Zod error there. */
export const BookSchema = z.object({
  startsAt: IsoInstant,
  guestTimezone: TimeZone,
  name: z.string().trim().min(1, "Enter your name").max(120, "Keep your name under 120 characters"),
  email: z.string().trim().min(1, "Enter your email address").max(320).email("Enter a full email address"),
  notes: z
    .string()
    .trim()
    .max(2000, "Keep the notes under 2000 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** The lead's booking token from `?lead=`, carried through the form so the meeting files under them. Never an id. */
  lead: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type BookValues = z.input<typeof BookSchema>;

export const RescheduleSchema = z.object({
  token: z.string().trim().min(16).max(128),
  startsAt: IsoInstant,
  guestTimezone: TimeZone,
});

export const CancelSchema = z.object({
  token: z.string().trim().min(16).max(128),
  reason: z
    .string()
    .trim()
    .max(500, "Keep the reason under 500 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** Five bookings an hour from one address is a script, not a person who changed their mind. */
export const BOOKING_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process for the life of the process, as on `/api/public/leads`. Exported so tests can reset it. */
export const bookingLimiter = new RateLimiter(BOOKING_RATE_LIMIT);

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
