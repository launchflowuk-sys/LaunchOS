import { publicSiteReviews } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { clientAddress, RateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Generous, because the callers are websites and the answer is cacheable.
 *
 * A busy client homepage behind a shared CDN node can legitimately ask often,
 * and every answer carries an hour of `max-age` — so this limit exists to stop
 * somebody scraping the whole slug space, not to ration real traffic. The
 * leads endpoint is ten a minute because each call *writes*; this one reads
 * one already-fetched row.
 */
const REVIEWS_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export const limiter = new RateLimiter(REVIEWS_RATE_LIMIT);

/** An hour, matching the brief and comfortably shorter than the daily refresh. */
const MAX_AGE_SECONDS = 3600;

/**
 * Any origin, because that is the entire point.
 *
 * A client's website is on their own domain and must be able to read this from
 * the browser. Nothing here is private: it is Google's public reviews of a
 * business that has asked us to show them. There is no cookie, no credential
 * and no `Access-Control-Allow-Credentials`, so an open origin grants a
 * stranger exactly what it grants the client's own page — a copy of something
 * already public.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
} as const;

/**
 * A client's Google reviews, for their own website to render.
 *
 * Unauthenticated on purpose. The whole feature exists so a client's site can
 * show its reviews **without holding a Google key** — putting a token on this
 * endpoint would mean every site author managing a credential, which is the
 * problem being solved.
 *
 * `404` for an unknown slug, a site with reviews switched off, and a site
 * whose listing has never been read successfully. All three are the same
 * answer deliberately: distinguishing them would tell the internet which
 * slugs exist and which clients have the feature turned off, and a client's
 * website treats 404 as "hide the band", which is right for all three.
 *
 * The raw Google payload is never returned — `publicSiteReviews` hands back
 * the stored, trimmed shape the client sites validate. `time` is Unix seconds
 * so a page can render "2 months ago" in its own language; `count` is Google's
 * `user_ratings_total` rather than the length of the array beside it.
 */
export async function GET(request: Request): Promise<Response> {
  const address = clientAddress(request);
  if (!limiter.allow(address)) {
    return NextResponse.json(
      { ok: false, error: "too many requests" },
      { status: 429, headers: { ...CORS, "retry-after": String(limiter.retryAfterSeconds(address)) } },
    );
  }

  const slug = new URL(request.url).searchParams.get("site")?.trim();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "pass ?site=<slug>" }, { status: 400, headers: CORS });
  }

  const data = await publicSiteReviews(getDb(), slug);
  if (!data) {
    // No cache header on a 404: a slug that is about to be switched on should
    // start working when it is switched on, not an hour later. The client
    // sites already cache a failure for five minutes themselves.
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
  }

  return NextResponse.json(
    { ok: true, data },
    {
      status: 200,
      headers: {
        ...CORS,
        "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
        // Reviews are refreshed once a day; a stale copy is far better than a
        // missing band while our own origin is down.
        "stale-while-revalidate": String(MAX_AGE_SECONDS),
      },
    },
  );
}

/** The preflight a cross-origin `fetch` sends before the GET. */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
