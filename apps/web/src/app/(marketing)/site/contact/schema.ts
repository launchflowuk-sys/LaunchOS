import { z } from "zod";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The contact form's contract, beside the action rather than in it so the
 * test can import the schema and the limiter without pulling in a server
 * action module.
 */

/** What the visitor sees after pressing send. Success carries no data: the page says thank you. */
export type ContactActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * The honeypot. A field a person never sees (it is visually hidden and out
 * of the tab order) and a bot fills because it is there. Named to look
 * worth filling; a value in it means the submission is dropped without a
 * word, since telling a script it was caught only teaches it.
 */
export const HONEYPOT_FIELD = "company_url";

const OptionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : undefined));

/** Bounds mirror core's `CreateLeadInput` so a refusal is a sentence on the form, not a thrown Zod error. */
export const ContactSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(200, "Keep your name under 200 characters"),
  email: z.string().trim().min(1, "Enter your email address").max(320).email("Enter a full email address"),
  phone: OptionalText(40, "Keep the phone number under 40 characters"),
  business: OptionalText(200, "Keep the business name under 200 characters"),
  message: z.string().trim().min(1, "Tell us what you need").max(4000, "Keep the message under 4000 characters"),
  /** Which page the form was on, for the lead's metadata. Never rendered back. */
  page: OptionalText(500, ""),
});
export type ContactValues = z.input<typeof ContactSchema>;

/** Five messages an hour from one address is a script, not a customer with a follow-up. */
export const CONTACT_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process for the life of the process, as on `/api/public/leads`. Exported so tests can reset it. */
export const contactLimiter = new RateLimiter(CONTACT_RATE_LIMIT);

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
