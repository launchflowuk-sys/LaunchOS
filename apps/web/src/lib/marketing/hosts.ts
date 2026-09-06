/**
 * Which hostname is the marketing site and which is the app.
 *
 * One Next app serves both: `launchflow.co.uk` (the agency's public site,
 * under `app/(marketing)/site/**`) and `os.launchflow.co.uk` (the admin and
 * client portals). `src/proxy.ts` rewrites `/` → `/site` and so on when the
 * request arrives on the marketing host, and `marketingHref()` decides
 * whether a link inside the marketing pages needs the `/site` prefix.
 *
 * A leaf module on purpose — no imports — because the proxy runs before any
 * route and must not pull `lib/env.ts` (and the integrations package behind
 * it) into its graph. `lib/env.ts` reads the same defaults from here so the
 * two cannot drift.
 */

export const DEFAULT_MARKETING_HOST = "launchflow.co.uk";
export const DEFAULT_APP_HOST = "os.launchflow.co.uk";

/** The path prefix the marketing route group lives under inside the app. */
export const MARKETING_PREFIX = "/site";

/** A blank env value is unset, the rule every other optional key follows. */
function fromEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

/** The two keys, as `process.env` or the parsed `Env` carries them. */
export type HostEnv = { MARKETING_HOST?: string | undefined; APP_HOST?: string | undefined };

export function marketingHostFromEnv(source: HostEnv): string {
  return fromEnv(source.MARKETING_HOST, DEFAULT_MARKETING_HOST);
}

export function appHostFromEnv(source: HostEnv): string {
  return fromEnv(source.APP_HOST, DEFAULT_APP_HOST);
}

/**
 * The hostname of a request, without a port, lower-cased. `x-forwarded-host`
 * first because Coolify puts Traefik in front of the container; `host` is
 * what a direct local call carries.
 */
export function requestHost(headers: { get(name: string): string | null }): string {
  const raw = headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
  const first = raw.split(",")[0]?.trim() ?? "";
  return first.replace(/:\d+$/, "").toLowerCase();
}

/** True for the marketing host itself and its `www.` alias. */
export function isMarketingHost(host: string, marketingHost: string): boolean {
  const h = host.trim().toLowerCase();
  return h === marketingHost || h === `www.${marketingHost}`;
}

/**
 * Served as themselves on the marketing host. `/after-sign-in` and `/portal`
 * are here because `/sign-in` is: a client who signs in on the wrong host
 * must land on their portal rather than on a 404 under `/site`. `/book` is
 * the public booking page: the acknowledgement email links to
 * `${APP_URL}/book?lead=…`, and `launchflow.co.uk/book` must answer the same
 * page, so it is the app's on both hosts like `/signup`.
 */
const PASS_THROUGH = ["/api", "/_next", "/sign-in", "/signup", "/after-sign-in", "/portal", "/book"] as const;

/**
 * Where a path on the marketing host is actually served from: `/` → `/site`,
 * `/work/x` → `/site/work/x`. Paths the app owns on every host (`/api`,
 * Next's own assets, the sign-in and sign-up screens, the portal, and any
 * file with an extension such as `/robots.txt`) are left alone, and so is a
 * path already under `/site` so a double prefix cannot happen.
 */
export function marketingRewriteTarget(pathname: string): string | null {
  if (pathname === MARKETING_PREFIX || pathname.startsWith(`${MARKETING_PREFIX}/`)) return null;
  if (PASS_THROUGH.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return null;
  if (/\.[a-z0-9]+$/i.test(pathname)) return null;
  return pathname === "/" ? MARKETING_PREFIX : `${MARKETING_PREFIX}${pathname}`;
}

/**
 * The prefix links inside the marketing pages carry: nothing on the
 * marketing host (the proxy adds `/site` on the way in) and `/site` anywhere
 * else, so `http://localhost:3000/site` and `os.launchflow.co.uk/site` stay
 * navigable for local review and Playwright.
 */
export function marketingPrefixFor(host: string, marketingHost: string): "" | typeof MARKETING_PREFIX {
  return isMarketingHost(host, marketingHost) ? "" : MARKETING_PREFIX;
}
