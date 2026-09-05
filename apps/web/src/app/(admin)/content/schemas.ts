import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/** `YYYY-MM`, the value an `<input type="month">` posts and `period_key` stores. */
export const PeriodKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month");

export const CONTENT_STATUSES = schema.contentStatusEnum.enumValues;
export const CONTENT_CHANNELS = schema.contentChannelEnum.enumValues;

/** The "Plan this month" / "Draft with AI" form: one client, one month, one intent. */
export const MonthActionSchema = z.object({
  clientId: z.string().uuid("Choose a client"),
  periodKey: PeriodKey,
  intent: z.enum(["plan", "draft"]),
});

/** A text field that arrives blank is a clear, not a no-op. */
const Cleared = z.string().trim().max(20_000);
/**
 * Only http(s). Zod's `.url()` accepts any scheme the URL constructor parses,
 * including `javascript:` — and a link typed here (or suggested by a client)
 * is rendered as a clickable anchor on the Approvals screen.
 */
export const HttpUrl = z
  .string()
  .trim()
  .max(2000)
  .url("Enter a full web address, starting https://")
  .refine((v) => /^https?:\/\//i.test(v), "Enter a full web address, starting https://");
const ClearedUrl = z.union([z.literal(""), HttpUrl]);

export const EditItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().max(200, "Keep the title under 200 characters"),
  body: Cleared,
  imageUrl: ClearedUrl,
  linkUrl: ClearedUrl,
  /** `YYYY-MM-DDTHH:mm` from a datetime-local input, or blank to unschedule. */
  scheduledFor: z.union([
    z.literal(""),
    z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter a date and time"),
  ]),
});

export const ItemIdSchema = z.object({ itemId: z.string().uuid() });

export const CancelItemSchema = z.object({
  itemId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
