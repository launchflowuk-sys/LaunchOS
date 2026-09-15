import { RateLimiter } from "@/lib/rate-limit";

/**
 * The blog endpoint's limiter and headers, beside the route rather than in it.
 *
 * **A route module may only export the HTTP handlers.** Next generates a type
 * for every `route.ts` that constrains its exports, so an exported `limiter`
 * fails `next build` with "Type 'RateLimiter' is not assignable to type
 * 'never'" — and `pnpm typecheck` cannot catch it, because those generated
 * types do not exist until `next build` writes them. `api/public/reviews`
 * splits its `limits.ts` off for the same reason, and `api/public/leads` its
 * `intake.ts`.
 */

/**
 * The same shape as the reviews limiter, and for the same reason: the callers
 * are websites, every answer carries cache headers, and the limit is here to
 * stop somebody walking the slug space rather than to ration real traffic.
 *
 * A blog page does one request per render where a reviews band does one per
 * page, so if anything this sees less traffic than reviews does.
 */
export const BLOG_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export const limiter = new RateLimiter(BLOG_RATE_LIMIT);

/**
 * Five minutes, much shorter than the reviews hour.
 *
 * Reviews change once a day, so an hour costs nothing. A blog post publishes
 * at a scheduled minute, and the whole promise is that it appears then — an
 * hour of cache would make "published at 09:00" mean "somewhere before 10:00"
 * on the client's own site. Five minutes keeps the CDN useful without making
 * the schedule a lie.
 */
export const MAX_AGE_SECONDS = 300;

/**
 * Any origin, because that is the entire point.
 *
 * A client's application is on their own domain and renders this from the
 * server or the browser. Nothing here is private: it is the client's own
 * published blog, written for the public to read. There is no cookie, no
 * credential and no `Access-Control-Allow-Credentials`, so an open origin
 * grants a stranger exactly what it grants the client's own page — a copy of
 * something already published.
 */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
} as const;
