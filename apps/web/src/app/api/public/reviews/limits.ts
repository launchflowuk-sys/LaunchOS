import { RateLimiter } from "@/lib/rate-limit";

/**
 * The reviews endpoint's limiter and headers, beside the route rather than in
 * it.
 *
 * **A route module may only export the HTTP handlers.** Next generates a type
 * for every `route.ts` that constrains its exports, so an exported `limiter`
 * fails `next build` with "Type 'RateLimiter' is not assignable to type
 * 'never'" — and `pnpm typecheck` cannot catch it, because those generated
 * types do not exist until `next build` writes them. `api/public/leads`
 * splits `intake.ts` off for the same reason, and so does this.
 */

/**
 * Generous, because the callers are websites and every answer carries an hour
 * of `max-age`.
 *
 * A busy client homepage behind a shared CDN node can legitimately ask often,
 * so this limit exists to stop somebody walking the whole slug space rather
 * than to ration real traffic. The leads endpoint is ten a minute because
 * each call *writes*; this one reads one already-fetched row.
 */
export const REVIEWS_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export const limiter = new RateLimiter(REVIEWS_RATE_LIMIT);

/** An hour, matching the brief and comfortably shorter than the daily refresh. */
export const MAX_AGE_SECONDS = 3600;

/**
 * Any origin, because that is the entire point.
 *
 * A client's website is on their own domain and must be able to read this
 * from the browser. Nothing here is private: it is Google's public reviews of
 * a business that asked us to show them. There is no cookie, no credential
 * and no `Access-Control-Allow-Credentials`, so an open origin grants a
 * stranger exactly what it grants the client's own page — a copy of something
 * already public.
 */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
} as const;
