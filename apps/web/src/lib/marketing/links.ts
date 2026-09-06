import { headers } from "next/headers";
import { cache } from "react";
import { appHost, marketingHost } from "@/lib/env";
import { isMarketingHost, marketingPrefixFor, requestHost } from "./hosts";

/**
 * A marketing path with the prefix the current host needs. Pure, so it can
 * be tested without a request: on the marketing host the prefix is empty and
 * `/` stays `/`; elsewhere `/` becomes `/site` and `/work` becomes `/site/work`.
 */
export function joinMarketingPath(prefix: string, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (prefix === "") return clean;
  return clean === "/" ? prefix : `${prefix}${clean}`;
}

export type MarketingLinks = {
  /** The hostname this request arrived on. */
  host: string;
  /** True when the proxy is adding `/site` for us, i.e. links must not. */
  onMarketingHost: boolean;
  /** `https://launchflow.co.uk` — the canonical origin every page points at. */
  canonicalBase: string;
  /** The portal's sign-in screen, always on the app host. */
  portalSignIn: string;
  /** The self-serve sign-up, always on the app host, optionally preselecting a package. */
  signup: (packageSlug?: string) => string;
  /** A link between marketing pages, correct for this host. */
  href: (path: string) => string;
};

/**
 * Everything a marketing page needs to build a link, read once per request.
 *
 * `headers()` opts the route into dynamic rendering, which is the accepted
 * cost of one app serving two hostnames: the pages themselves are a few
 * hundred lines of static data, and the one database read (pricing) is
 * cached separately with `unstable_cache`. `cache()` scopes the lookup to a
 * single render pass so the header, the page and the footer share it.
 */
export const marketingLinks = cache(async (): Promise<MarketingLinks> => {
  const host = requestHost(await headers());
  const marketing = marketingHost();
  const prefix = marketingPrefixFor(host, marketing);
  const app = `https://${appHost()}`;
  return {
    host,
    onMarketingHost: isMarketingHost(host, marketing),
    canonicalBase: `https://${marketing}`,
    portalSignIn: `${app}/sign-in`,
    signup: (packageSlug) => (packageSlug ? `${app}/signup?package=${encodeURIComponent(packageSlug)}` : `${app}/signup`),
    href: (path) => joinMarketingPath(prefix, path),
  };
});

/** One link, for a component that needs only one. */
export async function marketingHref(path: string): Promise<string> {
  return (await marketingLinks()).href(path);
}
