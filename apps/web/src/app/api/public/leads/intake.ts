import { LeadAttributionSchema } from "@launchos/core";
import { z } from "zod";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The public lead form's contract, next to the route rather than in it: a
 * `route.ts` may only export handlers and Next's config fields, and the
 * test needs the token header, the limit and the limiter itself.
 */

/** The header the website form's webhook sends the shared token in. */
export const TOKEN_HEADER = "x-public-forms-token";

/** Twenty enquiries an hour from one address is a script, not a customer. */
export const LEADS_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const;

const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * What launchflow.co.uk's form posts. Every field but the name is optional
 * because a form plugin sends what it has; bounds mirror core's
 * `CreateLeadInput` so a refusal is a 400 here rather than a thrown Zod
 * error there.
 */
export const PublicLeadBody = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  email: z
    .string()
    .trim()
    .max(320)
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().email("email is not an address").optional()),
  phone: OptionalText(40),
  business: OptionalText(200),
  message: OptionalText(4000),
  source: z.string().trim().min(1).max(60).default("website"),
  /** Where on the site the form was, if the plugin sends it. Kept on the lead's metadata. */
  page: OptionalText(500),
  /** UTM tags, click ids, landing path and referrer, if the form carried them. Core's own schema, so the bounds cannot drift. */
  attribution: LeadAttributionSchema.optional(),
});

/**
 * Module-scope on purpose: one counter per process for the life of the
 * process, which is what a per-IP limit means. Exported so the test can
 * reset it between cases.
 */
export const limiter = new RateLimiter(LEADS_RATE_LIMIT);

/** A contact form is a few hundred bytes; anything past this is not one. */
export const MAX_BODY_BYTES = 32 * 1024;

