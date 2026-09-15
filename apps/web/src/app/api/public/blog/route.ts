import { publicSiteBlog, publicSiteBlogPost } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { clientAddress } from "@/lib/rate-limit";
import { CORS, limiter, MAX_AGE_SECONDS } from "./limits";

export const dynamic = "force-dynamic";

/**
 * A client application's blog, for the application itself to render.
 *
 * Most of the estate is a Next.js application on Coolify with its own
 * Postgres rather than a WordPress install, so there is no CMS for LaunchOS to
 * push a post into. It keeps the posts instead and hands them out here; the
 * application fetches them and renders them as its own pages.
 *
 * Unauthenticated on purpose, exactly as the reviews endpoint is: putting a
 * token on this would mean every client application holding a credential,
 * which is the problem being solved. Nothing served here is private — it is a
 * client's own blog, published for the public to read.
 *
 * `?site=<slug>` lists the site's published posts, newest first.
 * `?site=<slug>&post=<slug>` returns one post.
 *
 * `404` for an unknown site, a blog channel switched off, a deleted site, a
 * WordPress site (whose posts live in WordPress) and an unknown post slug.
 * All of them are the same answer deliberately: distinguishing them would tell
 * the internet which slugs exist, and an application treats 404 as "no blog
 * here" or "no such post", which is right for every one of those cases.
 *
 * Posts are served as sanitised HTML rather than markdown, so no client
 * application needs a renderer of its own — the same reasoning as not making
 * each one hold a secret. Only `published` items are ever returned, and
 * `published` is what the publish sweep sets at a post's scheduled time, so
 * the schedule is what decides when a post appears on the client's site.
 */
export async function GET(request: Request): Promise<Response> {
  const address = clientAddress(request);
  if (!limiter.allow(address)) {
    return NextResponse.json(
      { ok: false, error: "too many requests" },
      { status: 429, headers: { ...CORS, "retry-after": String(limiter.retryAfterSeconds(address)) } },
    );
  }

  const params = new URL(request.url).searchParams;
  const slug = params.get("site")?.trim();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "pass ?site=<slug>" }, { status: 400, headers: CORS });
  }
  const postSlug = params.get("post")?.trim();

  const data = postSlug
    ? await publicSiteBlogPost(getDb(), slug, postSlug)
    : await publicSiteBlog(getDb(), slug);

  if (!data) {
    // No cache header on a 404: a blog about to be switched on should start
    // working when it is switched on, not five minutes later.
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
  }

  return NextResponse.json(
    { ok: true, data },
    {
      status: 200,
      headers: {
        ...CORS,
        "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
        // A stale post is far better than a blank blog while our origin is
        // down — the application keeps serving what it last saw.
        "stale-while-revalidate": String(MAX_AGE_SECONDS),
      },
    },
  );
}

/** The preflight a cross-origin `fetch` sends before the GET. */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
