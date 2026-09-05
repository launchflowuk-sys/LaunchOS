import { z } from "zod";

/**
 * Local to this module rather than shared — every module in this app defines
 * its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const SuggestPostSchema = z.object({
  text: z.string().trim().min(1, "Tell us what the post should say").max(4000, "Keep it under 4,000 characters"),
  // http(s) only: this value is rendered as a link on the staff Approvals
  // screen, so a `javascript:` URL here would run in a staff member's session.
  linkUrl: z.union([
    z.literal(""),
    z
      .string()
      .trim()
      .max(2000)
      .url("Enter a full web address, starting https://")
      .refine((v) => /^https?:\/\//i.test(v), "Enter a full web address, starting https://"),
  ]),
});

/** The first Zod issue, which is the one for the field the client just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
