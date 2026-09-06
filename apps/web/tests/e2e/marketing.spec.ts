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

/** Every marketing page, for the width check. */
const PAGES = ["/site", "/site/work", "/site/work/grays-cabline", "/site/products", "/site/services", "/site/pricing", "/site/about", "/site/contact", "/site/privacy"];

const OUT_DIR = resolve(process.cwd(), "../../.superpowers");

const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const BUSINESS = `E2E Marketing Enquiry ${STAMP}`;

test.afterAll(async () => {
  await db.delete(schema.notifications).where(like(schema.notifications.title, `%${BUSINESS}%`)).catch(() => undefined);
  await db.delete(schema.leads).where(eq(schema.leads.business, BUSINESS));
});

test("home renders under /site with host-aware links", async ({ page }) => {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: "We build the software we run our own businesses on." })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Work" })).toHaveAttribute("href", "/site/work");
  await expect(page.getByRole("link", { name: "Client portal login" })).toHaveAttribute("href", /\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Recent work" })).toBeVisible();
  await expect(page.getByText("Powered by LaunchFlow")).toBeVisible();
});

test("a work brief renders with its sections and live link", async ({ page }) => {
  await page.goto("/site/work/grays-cabline");
  await expect(page.getByRole("heading", { level: 1, name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });
  for (const section of ["The client", "The problem", "What we built", "Results"]) {
    await expect(page.getByRole("heading", { name: section })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: /Visit grayscabline\.co\.uk/ })).toHaveAttribute("href", "https://grayscabline.co.uk");
  // The screenshot the capture script wrote, or the placeholder — never a broken image.
  const images = page.locator("main img");
  for (const image of await images.all()) {
    // The phone shot is rendered twice — beside the desktop one at `lg`, below the brief under it — and only one is shown.
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
  await expect(page.getByRole("heading", { level: 1, name: "Plain monthly pricing." })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: "Website Care" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started with Website Care" })).toHaveAttribute("href", /\/signup\?package=website-care$/);
  await expect(page.getByRole("link", { name: "Talk to us" }).first()).toHaveAttribute("href", "/site/contact");
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

test("every page fits a 390px phone with no sideways scroll", async ({ page }) => {
  // Nine routes, each compiled on first visit by the dev server.
  test.setTimeout(COLD_COMPILE * 3);
  await page.setViewportSize(MOBILE);
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible({ timeout: COLD_COMPILE });
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(MOBILE.width);
    expect(widths.body, `${path} body overflows`).toBeLessThanOrEqual(MOBILE.width);
  }
  // The menu is a native disclosure: it opens with no client script.
  await page.goto("/site");
  await page.locator("details.site-menu > summary").click();
  await expect(page.getByRole("link", { name: "Products" }).first()).toBeVisible();
});

test("on the marketing host the pages answer at / and links lose the /site prefix", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-host": MARKETING_HOST } });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "We build the software we run our own businesses on." })).toBeVisible({ timeout: COLD_COMPILE });
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

test("home page screenshots for the design review", async ({ page }) => {
  await mkdir(OUT_DIR, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/site");
  await expect(page.locator("h1")).toBeVisible({ timeout: COLD_COMPILE });
  await page.screenshot({ path: resolve(OUT_DIR, "marketing-home-desktop.png"), fullPage: true });
  await page.setViewportSize(MOBILE);
  await page.goto("/site");
  await expect(page.locator("h1")).toBeVisible();
  await page.screenshot({ path: resolve(OUT_DIR, "marketing-home-mobile.png"), fullPage: true });
});
