import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { marketingHost } from "@/lib/env";
import { isMarketingHost, requestHost } from "@/lib/marketing/hosts";
import { STATIC_PATHS } from "@/lib/marketing/site";
import { WORK } from "@/lib/marketing/work";

/** Newest first in the data file is not a rule; this is what the sitemap says changes. */
const CHANGE: Record<string, MetadataRoute.Sitemap[number]["changeFrequency"]> = {
  "/": "weekly",
  "/work": "weekly",
  "/products": "monthly",
  "/services": "monthly",
  "/pricing": "monthly",
  "/about": "yearly",
  "/contact": "yearly",
  "/privacy": "yearly",
};

/**
 * `/sitemap.xml`, marketing host only. Every URL is absolute on the
 * canonical host, whatever host the request came in on; on the app host the
 * list is empty because `robots.ts` disallows everything there anyway.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = marketingHost();
  if (!isMarketingHost(requestHost(await headers()), host)) return [];
  const base = `https://${host}`;
  const pages: MetadataRoute.Sitemap = STATIC_PATHS.map((path) => ({
    url: path === "/" ? base : `${base}${path}`,
    changeFrequency: CHANGE[path] ?? "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
  const briefs: MetadataRoute.Sitemap = WORK.map((item) => ({
    url: `${base}/work/${item.slug}`,
    changeFrequency: "monthly",
    priority: 0.6,
    ...(item.screenshots.desktop ? { images: [`${base}${item.screenshots.desktop}`] } : {}),
  }));
  return [...pages, ...briefs];
}
