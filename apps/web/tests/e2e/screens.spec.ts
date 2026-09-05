import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CLIENT, OWNER } from "./seed-credentials";

/**
 * The design pass's eyes.
 *
 * It is not an acceptance test and asserts almost nothing — it signs in and
 * saves full-page PNGs so a person (or a model) can look at the two viewports
 * that matter: the 375px phone PRODUCT.md says every screen must work at, and a
 * 1280px desktop. Skipped unless `SCREENS=1`, so `pnpm --filter @launchos/web
 * e2e` stays a test run.
 *
 *   SCREENS=1 SCREENS_ROUTES=/,/clients,/cases,/approvals,/portal \
 *     npx playwright test tests/e2e/screens.spec.ts
 *
 * Output lands in the repo-root `.superpowers/screens/` (gitignored) as
 * `<route-slug>-<mobile|desktop>.png`.
 */
const ENABLED = process.env.SCREENS === "1";

/** Playwright runs from `apps/web`, so the repo root is two levels up. */
const OUT_DIR = resolve(process.cwd(), "../../.superpowers/screens");

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

// The dev server compiles each route the first time it is requested.
const COLD_COMPILE = 120_000;

function routeSlug(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "home";
  return trimmed.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function requestedRoutes(): readonly string[] {
  return (process.env.SCREENS_ROUTES ?? "/")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean);
}

async function signInAs(page: Page, credentials: { email: string; password: string }, landing: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // /after-sign-in decides between the admin shell and the portal.
  await page.waitForURL(landing, { timeout: COLD_COMPILE });
}

/**
 * A staff session is bounced out of `/portal` and a client session out of the
 * admin shell, so the two surfaces are captured from their own contexts.
 */
const SURFACES = [
  { key: "admin", credentials: OWNER, landing: "/", owns: (route: string) => !route.startsWith("/portal") },
  { key: "portal", credentials: CLIENT, landing: "/portal", owns: (route: string) => route.startsWith("/portal") },
] as const;

test.describe("design screens", () => {
  test.skip(!ENABLED, "set SCREENS=1 to capture screenshots");

  test("captures every requested route at both viewports", async ({ browser }) => {
    test.setTimeout(900_000);

    const routes = requestedRoutes();
    await mkdir(OUT_DIR, { recursive: true });

    for (const viewport of VIEWPORTS) {
      for (const surface of SURFACES) {
        const mine = routes.filter(surface.owns);
        if (mine.length === 0) continue;

        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();
        try {
          await signInAs(page, surface.credentials, surface.landing);

          for (const route of mine) {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            // Every screen opens with a PageHeader, so one visible heading is
            // the cheapest "this route has finished compiling" signal there is.
            await expect(page.getByRole("heading").first()).toBeVisible({ timeout: COLD_COMPILE });
            await page.screenshot({
              path: `${OUT_DIR}/${routeSlug(route)}-${viewport.name}.png`,
              fullPage: true,
            });
          }
        } finally {
          await context.close();
        }
      }
    }
  });
});
