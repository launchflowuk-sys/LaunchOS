import { z } from "zod";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The public sign-off page's contract, beside the action rather than in it so
 * the tests can import the schema and the limiter without pulling in a
 * server-action module.
 *
 * This is `app/p/[token]/schemas.ts` for the other end of the job, and it is
 * deliberately the same file twice over rather than one file shared between
 * them: the two pages accept different things — a proposal can be declined
 * with a reason, a handover cannot — and the one thing they genuinely share,
 * the signature grammar, is core's (`documents/acceptance.ts`) and is checked
 * there for both. What is copied here is the *shape* of a public boundary in
 * this app: a Zod body that trusts nothing, bounds that mirror core's, and a
 * per-address limit so a script cannot hammer it.
 */

/** A failure is a sentence on the page; success re-renders it as signed off. */
export type PublicActionResult = { status: "error"; message: string };

/**
 * The one answer every refusal gives.
 *
 * A cancelled project, a token that never existed and a handover that has
 * already been signed all get the same sentence, for the same reason the
 * proposal page gives one: a page on the open internet that answers
 * differently is telling whoever is asking which of them they hold.
 */
export const NOT_OPEN =
  "This handover is not open for sign-off. Please reply to our email and we will sort it out.";

/** The token as it comes out of the URL. Core normalises it again before any query. */
const Token = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "that is not a handover link");

/**
 * Bounds mirror core's `SignOffDeliveryInput`, so a refusal is a sentence here
 * rather than a thrown Zod error there. The signature is path data and is
 * checked again by core against the SVG path grammar — this is the cheap
 * first pass, not the guard.
 */
export const SignOffSchema = z.object({
  token: Token,
  name: z.string().trim().min(1, "Please type your name").max(160, "Keep your name under 160 characters"),
  email: z.string().trim().min(1, "Please give your email address").max(320).email("That does not look like an email address"),
  signature: z
    .string()
    .trim()
    .min(1, "Please sign in the box above")
    .max(100_000, "That signature is too large to store — clear it and sign again")
    .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]*$/, "The signature could not be read — clear it and sign again"),
  terms: z.literal("on", { message: "Please tick to confirm the work is done" }),
});

/** Ten attempts an hour from one address is a script, not somebody signing off a build. */
export const SIGN_OFF_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process for the life of the process, as on `/p/<token>`. */
export const signOffLimiter = new RateLimiter(SIGN_OFF_RATE_LIMIT);

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
