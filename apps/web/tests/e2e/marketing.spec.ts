import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { eq, like } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The marketing site, served from `(marketing)/site/**`.
 *
 * Locally every page is reached under `/site` — the proxy only strips that
 * prefix when the request arrives on the marketing host — so the specs
 * visit `/site/...` and check the links they render carry the prefix too.
 * One case sends `x-forwarded-host: launchflow.co.uk`, which is what
 * Traefik sends in production, and checks the same pages answer at `/`.
 */
const COLD_COMPILE = 120_000;
const MOBILE = { width: 390, height: 844 };
const MARKETING_HOST = process.env.MARKETING_HOST?.trim() || "launchflow.co.uk";
const HOME_H1 = /Built to work\.\s*Designed to\s*stand out\./;

/** Every public page, for the width check: the site, and the two public flows outside it. */
const PAGES = [
  "/site",
  "/site/work",
  "/site/work/grays-cabline",
  "/site/products",
  "/site/services",
  "/site/pricing",
  "/site/about",
  "/site/contact",
  "/site/privacy",
  "/book",
  "/signup",
];

const OUT_DIR = resolve(process.cwd(), "../../.superpowers");

const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const BUSINESS = `E2E Marketing Enquiry ${STAMP}`;

test.afterAll(async () => {
  await db.delete(schema.notifications).where(like(schema.notifications.title, `%${BUSINESS}%`)).catch(() => undefined);
  await db.delete(schema.leads).where(eq(schema.leads.business, BUSINESS));
});

test("home renders under /site with host-aware links and the eight sections", async ({ page }) => {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Work" })).toHaveAttribute("href", "/site/work");
  await expect(page.getByRole("link", { name: "Client login" }).first()).toHaveAttribute("href", /\/sign-in$/);
  await expect(page.getByRole("link", { name: "Client portal" })).toHaveAttribute("href", /\/sign-in$/);
  for (const heading of [/Good things,\s*built for real people\./, /Every piece\.\s*One partner\./, /We're builders\.\s*And business owners\./, /We know what it takes\./, /Let's make\s*your next move\./]) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeAttached();
  }
  await expect(page.getByRole("contentinfo")).toContainText("LaunchFlow");
  await expect(page).toHaveTitle(/LaunchFlow/);
});

test("the services accordion is ARIA-correct and one row is open at a time", async ({ page }) => {
  await page.goto("/site");
  const first = page.getByRole("button", { name: /Web applications/ });
  const second = page.getByRole("button", { name: /Mobile apps/ });
  await expect(first).toHaveAttribute("aria-expanded", "true", { timeout: COLD_COMPILE });
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.scrollIntoViewIfNeeded();
  await second.click();
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  const panelId = await second.getAttribute("aria-controls");
  await expect(page.locator(`#${panelId}`)).toHaveAttribute("role", "region");
});

test("a work brief renders with the big screenshot, its sections and the live link", async ({ page }) => {
  await page.goto("/site/work/grays-cabline");
  await expect(page.getByRole("heading", { level: 1, name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });
  for (const section of ["The client", "The problem", "What we built", "Results"]) {
    await expect(page.getByRole("heading", { name: section })).toBeAttached();
  }
  await expect(page.getByRole("link", { name: /Visit grayscabline\.co\.uk/ })).toHaveAttribute("href", "https://grayscabline.co.uk");
  await expect(page).toHaveTitle("Grays CabLine — LaunchFlow");
  // The screenshot the capture script wrote, or the placeholder — never a broken image.
  const images = page.locator("main img");
  for (const image of await images.all()) {
    if (!(await image.isVisible())) continue;
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  await expect(page.getByRole("heading", { name: "That page is not here." })).toHaveCount(0);
});

test("an unknown work slug is a 404", async ({ page }) => {
  const response = await page.goto("/site/work/not-a-project");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "That page is not here." })).toBeVisible({ timeout: COLD_COMPILE });
});

test("pricing lists the seeded package and sends sign-up to /signup", async ({ page }) => {
  await page.goto("/site/pricing");
  await expect(page.getByRole("heading", { level: 1, name: /Simple monthly care\./ })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: "Website Care" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started with Website Care" })).toHaveAttribute("href", /\/signup\?package=website-care$/);
  await expect(page.getByRole("link", { name: /Let.s talk/ }).first()).toHaveAttribute("href", "/site/contact");
});

test("the contact form writes a lead the owner sees on /leads", async ({ page }) => {
  await page.goto("/site/contact");
  await expect(page.getByRole("heading", { level: 1, name: "Tell us what you need." })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByLabel("Your name").fill("Monika Test");
  await page.getByLabel("Email").fill(`monika.${STAMP}@e2e.example`);
  await page.getByLabel("Phone").fill("01375 000000");
  await page.getByLabel("Business").fill(BUSINESS);
  await page.getByLabel("What do you need?").fill("A booking system for the salon, please.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Thanks, your message is in.")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("status")).toContainText("Shoji will reply within one working day.");

  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.business, BUSINESS));
  expect(lead).toBeDefined();
  expect(lead!.source).toBe("website");
  expect(lead!.status).toBe("new");
  expect(lead!.email).toBe(`monika.${STAMP}@e2e.example`);

  await signIn(page);
  await page.goto("/leads");
  await expect(page.getByRole("link", { name: BUSINESS })).toBeVisible({ timeout: COLD_COMPILE });
});

test("the honeypot drops a bot's post without a lead", async ({ page }) => {
  await page.goto("/site/contact");
  await expect(page.getByRole("heading", { level: 1, name: "Tell us what you need." })).toBeVisible({ timeout: COLD_COMPILE });
  const trapped = `${BUSINESS} Bot`;
  await page.getByLabel("Your name").fill("Bot");
  await page.getByLabel("Email").fill(`bot.${STAMP}@e2e.example`);
  await page.getByLabel("Business").fill(trapped);
  await page.getByLabel("What do you need?").fill("buy now");
  await page.locator("input[name=company_url]").evaluate((el: HTMLInputElement) => {
    el.value = "https://spam.example";
  });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Thanks, your message is in.")).toBeVisible({ timeout: COLD_COMPILE });
  const rows = await db.select().from(schema.leads).where(eq(schema.leads.business, trapped));
  expect(rows).toHaveLength(0);
});

test("every public page fits a 390px phone with no sideways scroll and says LaunchFlow", async ({ page }) => {
  // Eleven routes, each compiled on first visit by the dev server.
  test.setTimeout(COLD_COMPILE * 4);
  await page.setViewportSize(MOBILE);
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page, `${path} title`).toHaveTitle(/LaunchFlow/);
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(MOBILE.width);
    expect(widths.body, `${path} body overflows`).toBeLessThanOrEqual(MOBILE.width);
  }
  // The menu is a native disclosure: it opens with no client script.
  await page.goto("/site");
  await page.locator("details.site-menu > summary").click();
  await expect(page.getByRole("link", { name: "Products" }).first()).toBeVisible();
});

test("reduced motion shows every section at rest; otherwise sections reveal on scroll", async ({ browser }) => {
  const calm = await browser.newContext({ reducedMotion: "reduce" });
  const page = await calm.newPage();
  try {
    await page.goto("/site");
    await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible({ timeout: COLD_COMPILE });
    const opacity = await page.locator("[data-reveal]").last().evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe("1");
  } finally {
    await calm.close();
  }
  const lively = await browser.newContext();
  const moving = await lively.newPage();
  try {
    await moving.goto("/site");
    const last = moving.locator("[data-reveal]").last();
    await expect(last).toHaveCSS("opacity", "0", { timeout: COLD_COMPILE });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toHaveClass(/is-in/);
    await expect(last).toHaveCSS("opacity", "1");
  } finally {
    await lively.close();
  }
});

test("on the marketing host the pages answer at / and links lose the /site prefix", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-host": MARKETING_HOST } });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Work" })).toHaveAttribute("href", "/work");
    await page.goto("/work/grays-cabline");
    await expect(page.getByRole("heading", { level: 1, name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });

    const robots = await page.request.get("/robots.txt");
    expect(await robots.text()).toContain(`Sitemap: https://${MARKETING_HOST}/sitemap.xml`);
    const sitemap = await page.request.get("/sitemap.xml");
    expect(await sitemap.text()).toContain(`https://${MARKETING_HOST}/work/grays-cabline`);
  } finally {
    await context.close();
  }
});

test("on the app host robots disallows everything and the marketing pages say noindex", async ({ page }) => {
  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toMatch(/Disallow: \/\s*$/m);
  await page.goto("/site");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("home and work-brief screenshots for the design review", async ({ browser }) => {
  // Reduced motion, so every scroll-revealed section is at rest in a full-page capture.
  await mkdir(OUT_DIR, { recursive: true });
  const shots = [
    ["home", "/site"],
    ["work", "/site/work/grays-cabline"],
  ] as const;
  for (const [name, path] of shots) {
    for (const [label, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", MOBILE],
    ] as const) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      try {
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(page.locator("h1")).toBeVisible({ timeout: COLD_COMPILE });
        await page.screenshot({ path: resolve(OUT_DIR, `marketing-v2-${name}-${label}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    }
  }
});

/**
 * Clicking through the site, which is not the same journey as loading a page.
 *
 * Reported from the live site: home reads fine, Work lists the projects, a
 * project opens with its screenshot and nothing under it, and going back to
 * Work leaves a header above an empty page that stays empty however many times
 * you return — until you visit some other page entirely.
 *
 * Every one of those screens passes a `goto` test, because a `goto` gives the
 * runtime a finished document to scan. A click does not: the pages are async
 * server components reading the database, so React commits the template while
 * the page is still suspended, the one-shot scan finds nothing, and everything
 * it should have revealed stays at `opacity: 0` for good.
 *
 * So this walks it with the mouse and asserts what a visitor would see —
 * computed opacity, not presence in the DOM. Playwright counts a fully
 * transparent element as visible, so `toBeVisible()` would have passed
 * throughout the bug.
 */
test("clicking home → work → a project → back to work leaves every section readable", async ({ page }) => {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible({ timeout: COLD_COMPILE });

  // Home → Work, by clicking the nav rather than loading the URL.
  await page.getByRole("navigation").getByRole("link", { name: "Work", exact: true }).first().click();
  await expect(page).toHaveURL(/\/site\/work$/);
  const firstCard = page.locator('a[href^="/site/work/"]').first();
  await expect(firstCard).toHaveCSS("opacity", "1", { timeout: COLD_COMPILE });

  // Work → a project. The screenshot is not a reveal target, so it showed even
  // while the brief beneath it did not; the brief is what this asserts.
  await firstCard.click();
  await expect(page).toHaveURL(/\/site\/work\/[a-z0-9-]+$/);
  const brief = page.getByRole("heading", { name: "The client" }).locator("xpath=ancestor::section[1]");
  await brief.scrollIntoViewIfNeeded();
  await expect(brief).toHaveCSS("opacity", "1", { timeout: COLD_COMPILE });

  // And back, which is where it stayed blank for good.
  await page.getByRole("link", { name: "All work" }).click();
  await expect(page).toHaveURL(/\/site\/work$/);
  await expect(page.locator('a[href^="/site/work/"]').first()).toHaveCSS("opacity", "1", { timeout: COLD_COMPILE });

  // Nothing anywhere on the page may be left invisible once it has been scrolled to.
  // Scrolled a screen at a time, the way a person reads it. Jumping to the
  // bottom would leave the middle of the page never having been on screen,
  // which is not a bug in a scroll reveal — it is the point of one.
  const screens = await page.evaluate(() => Math.ceil(document.body.scrollHeight / window.innerHeight));
  for (let i = 1; i <= screens; i += 1) {
    await page.evaluate((n) => window.scrollTo(0, n * window.innerHeight * 0.8), i);
    await page.waitForTimeout(250);
  }
  // Polled rather than slept: the reveal is a 500ms transition staggered 60ms
  // per sibling, so a fixed wait is either a flake or a guess. What matters is
  // that everything the visitor has actually scrolled to has settled visible.
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          [...document.querySelectorAll("[data-reveal]")]
            .filter((el) => getComputedStyle(el).opacity === "0")
            .map((el) => `${el.tagName}.${(el as HTMLElement).className}`.slice(0, 60)),
        ),
      { timeout: 10_000 },
    )
    .toEqual([]);
});

/**
 * The mobile menu closes when you use it.
 *
 * It is a native `<details>` so it works with no script, but `open` is DOM
 * state and the header lives in the layout, which React keeps across a
 * client-side navigation. Tapping a link navigated the page underneath and
 * left the menu sitting on top of it, so you had to close it by hand to read
 * what you had just asked for.
 *
 * Both closings are checked, because they cover different journeys: the tap
 * itself, and the pathname changing. The second one matters for the link to
 * the page you are already on, which changes no pathname at all.
 */
test("the mobile menu closes when a link inside it is tapped", async ({ browser }) => {
  const context = await browser.newContext({ viewport: MOBILE });
  const page = await context.newPage();
  try {
    await page.goto("/site");
    await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible({ timeout: COLD_COMPILE });

    // A `<summary>` is not a button to the accessibility tree, so it is
    // addressed as the element it is.
    const menu = page.locator("details.site-menu");
    const trigger = menu.locator("> summary");

    await trigger.click();
    await expect(menu).toHaveAttribute("open", "", { timeout: COLD_COMPILE });

    await menu.getByRole("link", { name: "Work" }).click();
    await expect(page).toHaveURL(/\/site\/work$/);
    await expect(menu).not.toHaveAttribute("open", "");

    // And the page under it is actually readable, which is the point.
    await expect(page.locator('a[href^="/site/work/"]').first()).toHaveCSS("opacity", "1", { timeout: COLD_COMPILE });

    // Re-opening still works, and the link to the page we are already on
    // closes it too — that one changes no pathname, so only the tap can.
    await trigger.click();
    await expect(menu).toHaveAttribute("open", "");
    await menu.getByRole("link", { name: "Work" }).click();
    await expect(menu).not.toHaveAttribute("open", "");
  } finally {
    await context.close();
  }
});
