import { schema } from "@launchos/db";
import type { MeetingKind, MeetingStatus } from "@launchos/db/schema";
import { z } from "zod";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const MEETING_STATUSES = schema.meetingStatusEnum.enumValues;
export const MEETING_KINDS = schema.meetingKindEnum.enumValues;

export const MEETING_STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  rescheduled: "Moved",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
};

export const MEETING_KIND_LABEL: Record<MeetingKind, string> = {
  discovery: "Discovery call",
  review: "Review",
  support: "Support",
  other: "Other",
};

/** Where a booking came from, in words. Free text on the row; unknown values show as typed. */
export const MEETING_SOURCE_LABEL: Record<string, string> = {
  public: "Booking page",
  email_link: "Email link",
  portal: "Client portal",
  admin: "Added by hand",
};

export const OUTCOME_LABEL = { completed: "Completed", no_show: "No-show" } as const;

export const MarkOutcomeSchema = z.object({
  meetingId: z.string().uuid(),
  outcome: z.enum(["completed", "no_show"], { message: "Choose an outcome" }),
  notes: z
    .string()
    .trim()
    .max(4000, "Keep the notes under 4000 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const CancelMeetingFormSchema = z.object({
  meetingId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .max(500, "Keep the reason under 500 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
