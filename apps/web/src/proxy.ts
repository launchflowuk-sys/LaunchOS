import { type NextRequest, NextResponse } from "next/server";
import { isMarketingHost, marketingHostFromEnv, marketingRewriteTarget, requestHost } from "@/lib/marketing/hosts";

/**
 * Serves the marketing site on its own hostname.
 *
 * `launchflow.co.uk` and `os.launchflow.co.uk` point at the same container.
 * On the marketing host a request for `/` is rewritten to `/site`, `/work`
 * to `/site/work`, and so on — `app/(marketing)/site/**` is where those
 * pages live, so nothing collides with the admin dashboard at `/`. The
 * `www.` alias is redirected to the bare host first so there is one address
 * for search engines. On any other host (the app, localhost, a tunnel) the
 * path is left exactly as it came, which keeps `/site/...` reachable for
 * local review and the Playwright suite.
 *
 * Reads `process.env` directly rather than `lib/env`: the proxy runs before
 * any route and its graph must stay tiny (see `lib/marketing/hosts.ts`).
 */
export function proxy(request: NextRequest): NextResponse {
  const marketingHost = marketingHostFromEnv({ MARKETING_HOST: process.env.MARKETING_HOST });
  const host = requestHost(request.headers);
  if (!isMarketingHost(host, marketingHost)) return NextResponse.next();

  if (host === `www.${marketingHost}`) {
    const url = request.nextUrl.clone();
    url.host = marketingHost;
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  const target = marketingRewriteTarget(request.nextUrl.pathname);
  if (!target) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url);
}

export const config = {
  // Never the app's own paths or a file with an extension — the same list
  // `marketingRewriteTarget` applies, repeated here as a constant because a
  // matcher must be statically analysable and cannot call a function.
  //
  // `p/` and `d/` carry their slashes on purpose: a bare `p` would exclude
  // `/pricing` from the proxy and take the marketing pricing page off the
  // marketing host, and a bare `d` would do the same to any future marketing
  // page beginning with one. Bare `/p` and `/d` are left in, and
  // `marketingRewriteTarget` passes them through anyway — the matcher is a
  // short-circuit, not the rule.
  matcher: ["/((?!api|_next|sign-in|signup|after-sign-in|portal|book|p/|d/|.*\\..*).*)"],
};
