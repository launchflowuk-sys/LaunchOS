import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { PRODUCTS } from "../src/lib/marketing/products";
import { WORK } from "../src/lib/marketing/work";

/**
 * Screenshots for the portfolio.
 *
 *   pnpm --filter @launchos/web exec tsx scripts/capture-portfolio.ts
 *
 * Visits every project and product that has a public address, captures a
 * desktop (1440×900) and a mobile (390×844) JPEG into `public/work/`, then
 * rewrites `src/lib/marketing/screenshots.json` from what is actually on
 * disk. A site that is down, not public, or answers with an error is
 * skipped with a line in the log, and whatever it had before is kept —
 * so a bad night for one client's server never blanks their card.
 *
 * Hand-placed files follow the same naming (`<slug>-desktop.jpg`,
 * `<slug>-mobile.jpg`) and are picked up by the manifest step like any
 * other. The manifest is what the pages read; a file that is not in it is
 * not rendered, which is how a broken image is made impossible.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../public/work");
const MANIFEST = resolve(here, "../src/lib/marketing/screenshots.json");

/** Under this the images are comfortably a single git object each and the folder stays small. */
const BUDGET_BYTES = 8 * 1024 * 1024;
const JPEG_QUALITY = 80;
const NAVIGATION_TIMEOUT_MS = 45_000;
/** Fonts, hero images and the odd entrance animation settle in this. */
const SETTLE_MS = 2_000;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * Products whose address is not a page of their own yet. The Funnel Engine
 * has no public site, and its entry points at the products page, which on
 * the day this runs may still be the old WordPress install.
 */
const OMIT = new Set(["funnel-engine"]);

/** A phone's own user agent, so a site that serves a different layout to phones shows it. */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type Target = { slug: string; url: string };

/** `--only a,b,c` recaptures just those slugs; everything else on disk is kept. */
const ONLY = new Set((process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "").split(",").filter(Boolean));

function targets(): Target[] {
  const wanted = (slug: string) => ONLY.size === 0 || ONLY.has(slug);
  const work = WORK.filter((item): item is typeof item & { url: string } => item.url !== null && wanted(item.slug)).map((item) => ({ slug: item.slug, url: item.url }));
  const products = PRODUCTS.filter((item) => !OMIT.has(item.slug) && wanted(item.slug)).map((item) => ({ slug: item.slug, url: item.url }));
  return [...work, ...products];
}

/**
 * A cookie banner over the hero is not the site. Best effort: the first
 * visible button whose label is one of the usual dismissals, and nothing
 * if there is none. "Reject" and "OK" before "Accept" — the capture should
 * not consent to analytics on a client's behalf.
 */
async function dismissCookieBanner(page: Page): Promise<void> {
  const labels = [/^(reject|reject all|decline|decline all)$/i, /^(ok|okay|got it|close|dismiss)$/i, /^(accept|accept all|i agree|agree|allow all)$/i];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000 }).catch(() => undefined);
      return;
    }
  }
}

async function capture(browser: Browser, target: Target): Promise<boolean> {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    const isMobile = name === "mobile";
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      isMobile,
      hasTouch: isMobile,
      locale: "en-GB",
      timezoneId: "Europe/London",
      ...(isMobile ? { userAgent: MOBILE_USER_AGENT } : {}),
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(target.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        console.log(`skip  ${target.slug}: ${target.url} answered ${status}`);
        return false;
      }
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await dismissCookieBanner(page);
      await page.waitForTimeout(SETTLE_MS);
      const file = resolve(OUT_DIR, `${target.slug}-${name}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: JPEG_QUALITY, fullPage: false });
      console.log(`ok    ${target.slug} ${name} ← ${page.url()}`);
    } catch (error) {
      console.log(`skip  ${target.slug}: ${target.url} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      return false;
    } finally {
      await context.close();
    }
  }
  return true;
}

/** Everything in `public/work` that follows the naming, as the pages will read it. */
function writeManifest(): number {
  const manifest: Record<string, { desktop?: string; mobile?: string }> = {};
  let total = 0;
  for (const file of readdirSync(OUT_DIR).sort()) {
    const match = /^(.+)-(desktop|mobile)\.jpg$/.exec(file);
    if (!match) continue;
    const [, slug, kind] = match as unknown as [string, string, "desktop" | "mobile"];
    total += statSync(resolve(OUT_DIR, file)).size;
    manifest[slug] = { ...(manifest[slug] ?? {}), [kind]: `/work/${file}` };
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return total;
}

async function main(): Promise<void> {
  const list = targets();
  console.log(`capturing ${list.length} sites into ${OUT_DIR}`);
  const browser = await chromium.launch();
  let captured = 0;
  try {
    for (const target of list) if (await capture(browser, target)) captured += 1;
  } finally {
    await browser.close();
  }
  const total = writeManifest();
  const mb = (total / 1024 / 1024).toFixed(2);
  console.log(`done: ${captured}/${list.length} captured, ${mb} MB on disk, manifest → ${MANIFEST}`);
  if (total > BUDGET_BYTES) {
    console.error(`over budget: ${mb} MB exceeds ${(BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB — lower JPEG_QUALITY or drop a target`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
