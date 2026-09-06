# LaunchFlow marketing site

The public website for launchflow.co.uk lives inside this app, under `apps/web/src/app/(marketing)/site/**`. One container serves two hostnames: `launchflow.co.uk` (the marketing site) and `os.launchflow.co.uk` (the admin and client portals). Nothing on the marketing side needs a session, a build step of its own, or WordPress.

## How the two hosts share one app

- `apps/web/src/proxy.ts` runs on every request that is not `/api`, `/_next`, `/sign-in`, `/signup`, `/after-sign-in`, `/portal` or a file with an extension. When the request's host (`x-forwarded-host` behind Traefik, else `Host`) is `MARKETING_HOST`, it rewrites `/` → `/site`, `/work/x` → `/site/work/x`, and so on. `www.` is redirected (308) to the bare host. On any other host the path is left alone, so `http://localhost:3000/site` and `https://os.launchflow.co.uk/site` both work for review.
- Links inside the marketing pages come from `marketingLinks()` (`apps/web/src/lib/marketing/links.ts`), which reads the host once per request and returns `href(path)`: `/work` on the marketing host, `/site/work` elsewhere. `marketingHref(path)` is the one-link form. The pure joiner `joinMarketingPath` is unit-tested.
- `MARKETING_HOST` (default `launchflow.co.uk`) and `APP_HOST` (default `os.launchflow.co.uk`) are optional env vars declared in `apps/web/src/lib/env.ts`; the defaults live in `apps/web/src/lib/marketing/hosts.ts`, a leaf module the proxy can import without dragging the integrations package in.
- On the app host every marketing page carries `noindex`, and `app/robots.ts` disallows everything. On the marketing host `robots.txt` allows all and names `sitemap.xml`, which `app/sitemap.ts` builds from the static paths plus one entry per work brief (with its screenshot as an image entry). Every page sets `alternates.canonical` on the marketing origin, so the review copy can never be indexed as a duplicate.

## Pages

| Path | File | Notes |
|---|---|---|
| `/` | `site/page.tsx` | Hero, three proof points, four featured projects, products strip, how we work, CTA |
| `/work` | `site/work/page.tsx` | Every project as a card |
| `/work/[slug]` | `site/work/[slug]/page.tsx` | The brief: client, problem, what we built, results, stack, screenshots, live link, prev/next |
| `/products` | `site/products/page.tsx` | The eight products, alternating screenshot and copy |
| `/services` | `site/services/page.tsx` | Seven services, numbered |
| `/pricing` | `site/pricing/page.tsx` | Active packages from the database, `Get started` → `/signup?package=<slug>` on the app host |
| `/about` | `site/about/page.tsx` | Shoji, the principles, the numbers |
| `/contact` | `site/contact/page.tsx` | The enquiry form |
| `/privacy` | `site/privacy/page.tsx` | What is collected and why |

The frame (header with a no-JavaScript mobile menu, footer with the client-portal login) is `site/layout.tsx` plus `site/_components/`. Marketing-only CSS is `site/marketing.css` — a 16px base, display tracking, the screenshot frame — and everything else comes from `globals.css`.

## Content

All copy that is data lives in `apps/web/src/lib/marketing/`:

- `work.ts` — the portfolio, one typed object per project (`slug`, `name`, `client`, `sector`, `url`, `summary`, `brief`, `stack`, `year`, `featured`, `kind`, `status`, `charity`).
- `products.ts` — the products.
- `services.ts` — the services.
- `site.ts` — name, tagline, contact email, phone (blank until chosen), location, nav.
- `screenshots.json` — written by the capture script, never by hand.

Adding a project is a new entry in `work.ts`; the sitemap, the cards and the prev/next links follow.

## Screenshots

```
pnpm --filter @launchos/web exec tsx scripts/capture-portfolio.ts
```

Visits every project and product with a URL, captures 1440×900 and 390×844 JPEGs (quality 80) into `apps/web/public/work/<slug>-{desktop,mobile}.jpg`, dismisses a cookie banner if one is in the way (reject before accept), skips anything down or not public with a log line, and rewrites `screenshots.json` from what is on disk. A project with no entry in the manifest renders a placeholder card, never a broken image. Hand-placed files with the same naming are picked up too. Budget: 8 MB for the folder; the script exits non-zero above it.

## Pricing data

`pricingPackages()` (`lib/marketing/packages.ts`) wraps `listPackages(db, org, { activeOnly: true })` in `unstable_cache` with a five-minute revalidation, sorted cheapest first. The organisation is the single active one (`publicOrganisationId`), as on `/signup`.

## Contact form

`site/contact/actions.ts` is a server action: Zod on every field (`schema.ts`), a honeypot field (`company_url`) whose presence drops the post silently, and a per-address limit of five an hour (`RateLimiter`, the same class `/api/public/leads` uses). A good post calls `createLead` with `source: "website"`, `actorKind: "client"` and `metadata.form = "contact"`, which audits, rings the owner's bell and appears on `/leads` exactly as a webhook lead does.

## Tests

- Unit: `lib/marketing/*.test.ts`, `site/contact/schema.test.ts` (`pnpm --filter @launchos/web test`).
- End to end: `apps/web/tests/e2e/marketing.spec.ts` — home, a brief, a 404, pricing, the contact form writing a lead the owner sees, the honeypot, a 390px width check across every page, the marketing-host rewrite via `x-forwarded-host`, robots and sitemap on both hosts, and two home-page screenshots into `.superpowers/`.

## Coolify

On the `web` resource in the LaunchOS project:

1. Domains: add `https://launchflow.co.uk` and `https://www.launchflow.co.uk` beside `https://os.launchflow.co.uk` (comma-separated in the Domains field). Let's Encrypt issues certificates for all three.
2. DNS: `A` (or `CNAME`) for `launchflow.co.uk` and `www` to the Hetzner server, the same target as `os`.
3. Env: nothing required. Set `MARKETING_HOST` / `APP_HOST` only if the hostnames ever differ from the defaults.
4. Redeploy. Check `https://launchflow.co.uk/robots.txt` names the sitemap, `https://www.launchflow.co.uk/` redirects to the bare host, and `https://os.launchflow.co.uk/robots.txt` says `Disallow: /`.
5. Only then point the domain away from WordPress. Keep the old site's export for the pages that were not carried over (blog posts, if any).
