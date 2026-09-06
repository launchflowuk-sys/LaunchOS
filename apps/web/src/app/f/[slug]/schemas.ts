import { z } from "zod";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The public funnel's contract, beside the actions rather than in them: a
 * `"use server"` module may only export async functions, and the runner and
 * its test both need these.
 */

/** What an answer action gives the runner back. A failure is a sentence under the question. */
export type FunnelActionResult =
  | { status: "ok"; token: string; captured: boolean }
  | { status: "error"; message: string };

const Slug = z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9][a-z0-9-]*$/);

export const AnswerSchema = z.object({
  /** The funnel is named by its public slug, never by an id the browser holds. */
  slug: Slug,
  /** Absent on the first answer of a walk; the action mints the session then. */
  token: z.string().trim().regex(/^[a-f0-9]{32}$/).optional(),
  stepKey: z.string().trim().min(1).max(60),
  choice: z.string().trim().max(60).optional(),
  text: z.string().trim().max(2000).optional(),
  contact: z.object({
    name: z.string().trim().min(1, "Enter your name").max(120),
    phone: z.string().trim().min(4, "Enter a phone number we can reach you on").max(40),
    email: z.string().trim().max(320).optional(),
    business: z.string().trim().max(200).optional(),
  }).optional(),
});
export type AnswerValues = z.input<typeof AnswerSchema>;

export const CompleteSchema = z.object({
  slug: Slug,
  token: z.string().trim().regex(/^[a-f0-9]{32}$/),
});

/**
 * Sixty answers an hour from one address. Higher than the booking limit
 * because one honest walk is six of these, and lower than a script needs to
 * be worth writing.
 */
export const FUNNEL_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process for the life of the process, as on `/api/public/leads`. Exported so tests can reset it. */
export const funnelLimiter = new RateLimiter(FUNNEL_RATE_LIMIT);

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
