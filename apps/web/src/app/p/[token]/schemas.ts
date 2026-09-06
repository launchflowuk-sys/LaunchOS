import { z } from "zod";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The public proposal page's contract, beside the actions rather than in them
 * so the tests can import the schemas and the limiter without pulling in a
 * server-action module.
 *
 * This is one of three places in the app a stranger can write — the website
 * lead form and the booking page are the others — so it is built the same way
 * they are: a Zod body that trusts nothing, bounds that mirror core's, and a
 * per-address limit so a script cannot hammer it.
 */

/** A failure is a sentence on the page; success re-renders it as decided. */
export type PublicActionResult = { status: "error"; message: string };

/**
 * The one answer every refusal gives.
 *
 * "No such proposal", "already decided" and "the date has passed" are
 * deliberately the same sentence. A page on the open internet that answers
 * differently for a token that never existed and one that merely ran out is
 * telling whoever is asking which of the two they have — and a client who
 * has hit one of these needs a person, not a taxonomy.
 */
export const NOT_OPEN =
  "This proposal is not open for a decision. Please reply to our email and we will sort it out.";

/** The token as it comes out of the URL. Core normalises it again before any query. */
const Token = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "that is not a proposal link");

/**
 * Bounds mirror core's `AcceptProposalInput`, so a refusal is a sentence here
 * rather than a thrown Zod error there. The signature is path data and is
 * checked again by core against the SVG path grammar — this is the cheap
 * first pass, not the guard.
 */
export const AcceptSchema = z.object({
  token: Token,
  name: z.string().trim().min(1, "Please type your name").max(160, "Keep your name under 160 characters"),
  email: z.string().trim().min(1, "Please give your email address").max(320).email("That does not look like an email address"),
  signature: z
    .string()
    .trim()
    .min(1, "Please sign in the box above")
    .max(100_000, "That signature is too large to store — clear it and sign again")
    .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]*$/, "The signature could not be read — clear it and sign again"),
  terms: z.literal("on", { message: "Please tick to agree to the terms" }),
});

export const DeclineSchema = z.object({
  token: Token,
  reason: z
    .string()
    .trim()
    .max(2000, "Keep the reason under 2000 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** Ten decisions an hour from one address is a script, not somebody making their mind up. */
export const PROPOSAL_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process for the life of the process, as on `/api/public/leads`. */
export const proposalLimiter = new RateLimiter(PROPOSAL_RATE_LIMIT);

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
