# apps/grow — the campaign landing page

The approved one-page LaunchFlow advert destination, served at
**https://grow.launchflow.co.uk/**. Paid traffic from Facebook, Instagram and
Google Ads lands here; every enquiry button sends the visitor on to the
existing brief funnel at `https://launchflow.co.uk/start`, carrying the
campaign tags with it.

## Why this is not a route in `apps/web`

It could have been. `proxy.ts` already serves two hostnames from one Next
container, and a third would have been a few lines. It is a separate nginx
container instead for one reason: **the page is an approved design and the
bytes are the specification.** Porting 39 lines of dense HTML to JSX and
scoping every global CSS selector away from the live marketing site is a large
opportunity to change something that was signed off, for no gain — there is
nothing dynamic on this page, and nothing here needs the database, the session
or `@launchos/core`.

`SOURCE-SHA256.json` is the handover package's byte-level record of the
approved source. `reference/index.html` is the original head, untouched, for
comparison against the deployed copy.

Every file under `public/` except `index.html` is **byte-identical** to the
approved source. `index.html` differs only in its `<head>`: a self-canonical,
the Open Graph tags reusing the marketing site's existing approved share card,
and the `tracking.js` include. No section, word, colour, class, spacing or
image was changed.

## No package.json, on purpose

`pnpm-workspace.yaml` globs `apps/*`, and a directory without a manifest is
simply not a workspace member — the same arrangement `packages/ui` uses.
There is nothing to install and nothing to build, so giving this a manifest
would only add it to every `pnpm -r` run for no reason.

## Files

| Path | What |
| --- | --- |
| `public/index.html` | The approved page. Head extended, body untouched |
| `public/style.css` | Approved, byte-identical |
| `public/app.js` | Approved, byte-identical — tabs and campaign forwarding |
| `public/assets/` | Logo, three project images, Geist — byte-identical |
| `tracking.js.template` | Ad measurement. Inert until ids are configured |
| `nginx.conf` | Serves the files. A missing file is a 404, never the page |
| `docker-entrypoint.sh` | `envsubst` over the template, then nginx |
| `reference/index.html` | The approved head, for diffing |

The Dockerfile is `infra/Dockerfile.grow`, beside the web and worker ones.

## Run it locally

From the repository root:

```bash
docker build -f infra/Dockerfile.grow -t launchflow-grow . && docker run --rm -p 8080:80 launchflow-grow
```

Then open `http://localhost:8080/`. To see a campaign arrive and be forwarded:

```text
http://localhost:8080/?utm_source=facebook&utm_medium=paid_social&utm_campaign=launchflow_growth&utm_content=creative_a
```

Hover any enquiry button — the tags are on the `/start` link. **The buttons
point at production**, so do not submit a test brief from here without meaning
to.

## Measurement

`tracking.js.template` becomes `tracking.js` at container start. With no ids
set it does nothing at all: no script fetched, no cookie, no consent banner,
and the page behaves exactly as the approved source does. That is how it
ships.

| Variable | What |
| --- | --- |
| `GROW_GA4_ID` | `G-XXXXXXXXXX`. Enables GA4 and the consent banner |
| `GROW_META_PIXEL_ID` | Meta pixel / dataset id. Enables the pixel |
| `GROW_ADS_CONVERSION_ID` | `AW-XXXXXXXXX`, so Ads may receive conversions |

A CTA click reports `funnel_cta_click` (GA4) and `FunnelCtaClick` (Meta).
**Neither is a lead.** The primary conversion is a confirmed brief submission
and it fires on `launchflow.co.uk`, not here — see
`apps/web/src/components/analytics/`.

Consent is stored per origin, so a visitor who accepts here is asked again on
`launchflow.co.uk`. That is a property of browsers, not a bug, and it is not
worked around with a shared-domain cookie.

## Coolify

**Live since 13 Sep 2026** at https://grow.launchflow.co.uk — application
`z793rvhukrqyarj7kvw9pwu9`, in the LaunchOS project's production environment.

- Build pack **Dockerfile**, Dockerfile `/infra/Dockerfile.grow`, base
  directory `/`, port **80**.
- Auto-deploy on, force-HTTPS on, Let's Encrypt certificate.
- Its uuid is in `infra/server/launchos-image-cleanup.sh` so old images are
  tidied like the other two apps'.

It shares the repository with the web and worker apps, so a push to `main`
rebuilds all three. This one builds in about sixteen seconds — it is a file
copy into nginx, with nothing to install and nothing to compile.

Set `GROW_GA4_ID`, `GROW_META_PIXEL_ID` and `GROW_ADS_CONVERSION_ID` on **this**
application, not on `launchos-web`, and only once the real ids exist.
