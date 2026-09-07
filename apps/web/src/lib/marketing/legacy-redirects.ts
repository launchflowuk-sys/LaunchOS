/**
 * Where the old WordPress site's addresses go now.
 *
 * launchflow.co.uk was a WordPress site before this one — a blog, service
 * pages, a set of template demos and a FluentCart install. Search Console still
 * knows every one of those URLs, and today they 404: the old paths carry a
 * trailing slash, Next strips it (that is the "page with redirect" line in the
 * coverage report) and what is left has nothing behind it (the "not found"
 * line). Two symptoms, one cause.
 *
 * A 404 throws away whatever links and rankings a page had. A 301 keeps them,
 * so anything with a real successor gets one.
 *
 * **What is deliberately not here matters as much as what is.** The old blog
 * posts — pieces about SPF and DKIM, email signatures, local SEO — have no
 * successor on this site, and sending them to `/services` would be a lie a
 * search engine sees straight through: mass redirects to a page that does not
 * answer the same question are treated as soft 404s and dropped anyway, and
 * they cost a reader who followed a link about DMARC and got a sales page. They
 * are left to 404 honestly. If those articles are ever republished under the
 * new blog, they earn a redirect then.
 *
 * Also not here: `/feed/` and its variants, `/wp-json/`, `/wp-login.php`,
 * `/comments/feed/`, `/search/{search_term_string}/`. Machinery, never content,
 * no value to carry across.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  // The old front page and the routes into it.
  "/home": "/",
  "/get-started": "/contact",
  "/onboarding": "/contact",
  "/meeting-confirmation": "/contact",

  // Service pages, all answered by one page now.
  "/how-it-works": "/services",
  "/get-customers-online": "/services",

  // Plans.
  "/hosting-upgrade": "/pricing",

  // One privacy page replaces four legal ones.
  "/privacy-policy": "/privacy",
  "/cookie-policy": "/privacy",
  "/terms-of-service": "/privacy",
  "/legal": "/privacy",

  // The template demos and the one client page that had its own URL. The work
  // index is the honest successor: it is what somebody looking at a cleaning
  // template or a past client actually wanted to see.
  "/web-templates": "/work",
  "/website-templates/barber": "/work",
  "/website-templates/beauty-salon": "/work",
  "/website-templates/cleaning-service": "/work",
  "/website-templates/electrician": "/work",
  "/website-templates/plumber": "/work",
  "/website-templates/taxi": "/work",
  "/web-templates/cleaning-service": "/work",
  "/sunlight-interiors": "/work",
};

/**
 * The successor for an old path, or null.
 *
 * Trailing slashes are taken off first: every one of these was crawled with one
 * and Next strips it before anything else runs, so matching without would miss
 * the form Google actually holds.
 */
export function legacyRedirectFor(pathname: string): string | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return LEGACY_REDIRECTS[path] ?? null;
}
