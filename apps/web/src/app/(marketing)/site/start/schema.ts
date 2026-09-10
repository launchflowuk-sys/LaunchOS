import { z } from "zod";
import type { TradingStructure, TriageAnswer } from "@launchos/core";

/**
 * Restated rather than imported, and for a reason that is invisible to `tsc`:
 * the wizard is a client component and imports `HONEYPOT_FIELD` from this file,
 * so a *value* import of `@launchos/core` here drags the core barrel — and the
 * database driver, and web-push — into the browser bundle. It fails at build
 * with `Can't resolve 'net'` and typechecks perfectly either way.
 *
 * `satisfies` keeps them honest: add a value in core and this stops compiling.
 */
const TRADING_STRUCTURES = ["sole_trader", "limited_company", "partnership", "not_sure"] as const satisfies readonly TradingStructure[];
const TRIAGE_ANSWERS = ["yes", "no", "unsure"] as const satisfies readonly TriageAnswer[];
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The wizard's contract, beside the action so a test can import it without
 * pulling in a server action module — the same arrangement `/contact` uses.
 *
 * Only the first step is required. Everything after it is optional on purpose:
 * somebody who gives their name and email and then closes the tab is still a
 * lead worth chasing, and a wizard that refuses to submit until every question
 * is answered turns that person into nobody.
 */

export type StartActionResult = { status: "ok" } | { status: "error"; message: string };

/** Same trap as the contact form: invisible to a person, irresistible to a script. */
export const HONEYPOT_FIELD = "company_url";

const OptionalText = (max: number, message = "") =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : undefined));

const OptionalChoice = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values), z.literal("")])
    .optional()
    .transform((v) => (v ? (v as T[number]) : undefined));

/** Bounds mirror core's `CreateLeadInput` and `LeadQualification`. */
export const StartSchema = z.object({
  // Step one. The only step that must be answered, because it is the only one
  // that makes the rest reachable.
  name: z.string().trim().min(1, "Enter your name").max(200, "Keep your name under 200 characters"),
  email: z.string().trim().min(1, "Enter your email address").max(320).email("Enter a full email address"),
  phone: OptionalText(40, "Keep the phone number under 40 characters"),

  business: OptionalText(200, "Keep the business name under 200 characters"),
  industry: OptionalText(120, "Keep the industry under 120 characters"),
  tradingStructure: OptionalChoice(TRADING_STRUCTURES),
  websiteUrl: OptionalText(300, "Keep the address under 300 characters"),

  hasGoogleListing: OptionalChoice(TRIAGE_ANSWERS),
  hasFacebookPage: OptionalChoice(TRIAGE_ANSWERS),
  serviceArea: OptionalText(200, "Keep the area under 200 characters"),

  services: OptionalText(2000, "Keep this under 2000 characters"),
  goals: OptionalText(2000, "Keep this under 2000 characters"),
  timeline: OptionalText(200, "Keep this under 200 characters"),
  budget: OptionalText(200, "Keep this under 200 characters"),

  /** Which page they started from, for the lead's metadata. Never rendered back. */
  page: OptionalText(500),
});
export type StartValues = z.input<typeof StartSchema>;

/**
 * Six an hour per address. Generous for a person who submits, changes their
 * mind and submits again; useless to a script trying to fill the owner's phone
 * with lead buzzes.
 */
export const START_RATE_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 } as const;

/** One counter per process, as on /contact. Exported so a test can reset it. */
export const startLimiter = new RateLimiter(START_RATE_LIMIT);

export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
