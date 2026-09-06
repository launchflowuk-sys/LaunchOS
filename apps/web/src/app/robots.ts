import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { marketingHost } from "@/lib/env";
import { isMarketingHost, requestHost } from "@/lib/marketing/hosts";

/**
 * `/robots.txt` for both hostnames, decided per request.
 *
 * On the marketing host everything is crawlable and the sitemap is named.
 * On the app host — the admin and client portals, plus the review copy of
 * the marketing site at `/site` — nothing is: there is no public page there
 * worth an index entry, and the marketing pages already carry `noindex`
 * when served from it. Reading `headers()` makes this dynamic, which is the
 * point: one file, two answers.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = marketingHost();
  if (!isMarketingHost(requestHost(await headers()), host)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/portal/", "/sign-in", "/signup", "/after-sign-in"] },
    sitemap: `https://${host}/sitemap.xml`,
  };
}
