import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { listCaseStudies, updateCaseStudy } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import { config as loadEnv } from "dotenv";

/**
 * Screenshots for the portfolio.
 *
 *   pnpm --filter @launchos/web exec tsx scripts/capture-portfolio.ts
 *
 * Visits every case study that has a public address, captures a desktop
 * (1440×900) and a mobile (390×844) JPEG into `public/work/`, then writes what
 * is actually on disk back onto each row's `screenshots`. A site that is down,
 * not public, or answers with an error is skipped with a line in the log and
 * keeps whatever it had — so a bad night for one client's server never blanks
 * their card.
 *
 * The rows are the manifest now. `src/lib/marketing/screenshots.json` is gone
 * with `work.ts`: the pages read `case_studies`, so a path this script does not
 * write is a path no page renders, which is how a broken image stays
 * impossible. Hand-placed files following the same naming
 * (`<slug>-desktop.jpg`, `<slug>-mobile.jpg`) are picked up by the same step.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../public/work");

// The monorepo keeps one .env at the root; `next.config.ts` loads it for the
// app and this script is run by tsx, which does not.
loadEnv({ path: resolve(here, "../../../.env"), quiet: true });

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
 * Products whose address is not a page of their own yet — their entry
 * points at a shared page, so a screenshot would show the wrong thing.
 * Empty since the placeholder products were dropped; kept because the next
 * product to be announced before it has a site will need it again.
 */
const OMIT = new Set<string>();

/** A phone's own user agent, so a site that serves a different layout to phones shows it. */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type Target = { id: string; slug: string; url: string };

/** `--only a,b,c` recaptures just those slugs; everything else on disk is kept. */
const ONLY = new Set((process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "").split(",").filter(Boolean));

type Store = { db: ReturnType<typeof createDb>; organisationId: string };

/**
 * The database, and the organisation whose portfolio this is — the same rule
 * every public entry point follows: the oldest active organisation.
 */
async function store(): Promise<Store> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required to capture the portfolio");
  const db = createDb(url);
  const [organisation] = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  if (!organisation) throw new Error("no active organisation to capture a portfolio for");
  return { db, organisationId: organisation.id };
}

/** Every case study with a public address, drafts included — a draft is a launch about to happen. */
async function targets({ db, organisationId }: Store): Promise<Target[]> {
  const rows = await listCaseStudies(db, organisationId, { limit: 500 });
  return rows
    .filter((row) => row.url !== null && !OMIT.has(row.slug) && (ONLY.size === 0 || ONLY.has(row.slug)))
    .map((row) => ({ id: row.id, slug: row.slug, url: row.url! }));
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

/** Everything in `public/work` that follows the naming, keyed by slug. */
function onDisk(): { manifest: Record<string, { desktop?: string; mobile?: string }>; bytes: number } {
  const manifest: Record<string, { desktop?: string; mobile?: string }> = {};
  let bytes = 0;
  for (const file of readdirSync(OUT_DIR).sort()) {
    const match = /^(.+)-(desktop|mobile)\.jpg$/.exec(file);
    if (!match) continue;
    const [, slug, kind] = match as unknown as [string, string, "desktop" | "mobile"];
    bytes += statSync(resolve(OUT_DIR, file)).size;
    manifest[slug] = { ...(manifest[slug] ?? {}), [kind]: `/work/${file}` };
  }
  return { manifest, bytes };
}

/**
 * Writes what is on disk onto the rows the pages read. `actorKind: "system"`
 * because this is a script, not a person — `case_study.updated` in the audit
 * log should say so.
 */
async function saveManifest({ db, organisationId }: Store, list: readonly Target[]): Promise<number> {
  const { manifest, bytes } = onDisk();
  for (const target of list) {
    const screenshots = manifest[target.slug];
    if (!screenshots) continue;
    await updateCaseStudy(db, organisationId, {
      caseStudyId: target.id,
      screenshots,
      actorKind: "system",
    });
  }
  return bytes;
}

async function main(): Promise<void> {
  const shop = await store();
  const list = await targets(shop);
  console.log(`capturing ${list.length} sites into ${OUT_DIR}`);
  const browser = await chromium.launch();
  let captured = 0;
  try {
    for (const target of list) if (await capture(browser, target)) captured += 1;
  } finally {
    await browser.close();
  }
  const total = await saveManifest(shop, list);
  const mb = (total / 1024 / 1024).toFixed(2);
  console.log(`done: ${captured}/${list.length} captured, ${mb} MB on disk, ${list.length} case studies updated`);
  if (total > BUDGET_BYTES) {
    console.error(`over budget: ${mb} MB exceeds ${(BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB — lower JPEG_QUALITY or drop a target`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
