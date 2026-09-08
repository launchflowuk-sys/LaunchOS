import { expect, test, type Page } from "@playwright/test";
import { CLIENT, OWNER } from "./seed-credentials";

/**
 * No screen may scroll sideways on a phone.
 *
 * This exists because it happened. A `Panel` went out without `min-w-0`, a
 * table inside it sized to its own content, and the whole admin shell became
 * draggable left-to-right on a 375px screen — the page could not be read
 * without shoving it back into place. Nothing caught it: typecheck cannot see
 * layout, and no test measured a viewport.
 *
 * The rule is one line of CSS wide and impossible to hold in your head across
 * forty screens, so it is asserted instead. A grid or flex child defaults to
 * `min-width: auto` and refuses to shrink below its content; every child that
 * can hold a table needs `min-w-0` so the table's own `overflow-x-auto` is the
 * thing that scrolls.
 *
 * Detail screens are reached by following the first row of their list rather
 * than by hardcoding a seed id, so this keeps working when the seed changes.
 */

const PHONE = { width: 375, height: 812 } as const;
/** One pixel of slack: sub-pixel layout rounds up and is not a drag. */
const TOLERANCE = 1;
// The dev server compiles each route on its first request.
const COLD_COMPILE = 120_000;

const ADMIN_ROUTES = [
  "/",
  "/clients",
  "/leads",
  "/meetings",
  "/funnels",
  "/proposals",
  "/projects",
  "/websites",
  "/domains",
  "/tasks",
  "/content",
  "/case-studies",
  "/inbox",
  "/cases",
  "/incidents",
  "/payments",
  "/invoices",
  "/ads",
  "/ads/reports",
  "/approvals",
  "/briefs",
  "/agents/runs",
  "/knowledge",
  "/reports",
  "/team",
  "/team/health",
  "/team/timesheets",
  "/settings/organisation",
  "/settings/agents",
  "/settings/api-tokens",
  "/settings/billing",
  "/settings/email",
  "/settings/packages",
  "/settings/task-templates",
] as const;

/**
 * The client-facing side. A staff session is bounced out of `/portal`, so
 * these are walked from their own sign-in.
 */
const PORTAL_ROUTES = [
  "/portal",
  "/portal/sites",
  "/portal/domains",
  "/portal/tasks",
  "/portal/support",
  "/portal/proposals",
  "/portal/invoices",
  "/portal/plan",
  "/portal/content",
  "/portal/reports",
  "/portal/documents",
  "/portal/account",
] as const;

/** A list screen and the shape of the detail links it renders. */
const DETAIL_FROM = [
  { list: "/clients", pattern: /^\/clients\/[0-9a-f-]{36}$/ },
  { list: "/projects", pattern: /^\/projects\/[0-9a-f-]{36}$/ },
  { list: "/websites", pattern: /^\/websites\/[0-9a-f-]{36}$/ },
  { list: "/cases", pattern: /^\/cases\/[0-9a-f-]{36}$/ },
  { list: "/invoices", pattern: /^\/invoices\/[0-9a-f-]{36}$/ },
  { list: "/tasks", pattern: /^\/tasks\/[0-9a-f-]{36}$/ },
] as const;

async function signInAs(page: Page, credentials: { email: string; password: string }, landing: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(landing, { timeout: COLD_COMPILE });
}

/**
 * `next dev` compiles a route the first time it is asked for, and this walk
 * asks for forty of them in one test. A compile that overruns the timeout has
 * almost always finished by the time the request is repeated, so one retry
 * turns a routine cold start into a pause rather than a red suite. A route
 * that is genuinely broken still fails, because it fails twice.
 */
async function goto(page: Page, route: string): Promise<void> {
  try {
    await page.goto(route, { timeout: COLD_COMPILE, waitUntil: "domcontentloaded" });
  } catch {
    await page.goto(route, { timeout: COLD_COMPILE, waitUntil: "domcontentloaded" });
  }
}

async function widthOf(page: Page): Promise<{ scrollWidth: number; innerWidth: number; culprits: string[] }> {
  return page.evaluate(() => {
    const limit = window.innerWidth + 1;
    const culprits = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        // Zero-area nodes cannot make the page draggable, and an element whose
        // own overflow is `auto` is the intended scroller, not a leak.
        if (box.width === 0 || box.height === 0) return false;
        return box.right > limit;
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)}`);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, culprits };
  });
}

async function expectNoSidewaysScroll(page: Page, route: string): Promise<void> {
  const { scrollWidth, innerWidth, culprits } = await widthOf(page);
  expect(
    scrollWidth,
    `${route} scrolls sideways on a ${innerWidth}px screen (scrollWidth ${scrollWidth}). ` +
      `Widest offenders: ${culprits.join(" | ") || "none identified"}. ` +
      `Usually a grid/flex child missing min-w-0.`,
  ).toBeLessThanOrEqual(innerWidth + TOLERANCE);
}

test.describe("every admin screen fits a 375px phone", () => {
  test.use({ viewport: PHONE });

  test("no screen scrolls sideways", async ({ page }) => {
    // Forty routes on a cold dev server, each compiled on first request.
    test.setTimeout(COLD_COMPILE * 6);

    await signInAs(page, OWNER, "/");

    for (const route of ADMIN_ROUTES) {
      await goto(page, route);
      await expectNoSidewaysScroll(page, route);
    }

    for (const { list, pattern } of DETAIL_FROM) {
      await goto(page, list);
      const href = await page
        .locator("a[href]")
        .evaluateAll(
          (anchors, source) =>
            anchors
              .map((anchor) => new URL((anchor as HTMLAnchorElement).href).pathname)
              .find((path) => new RegExp(source).test(path)) ?? null,
          pattern.source,
        );
      // An empty list is not a failure — it is a seed with nothing in it.
      if (!href) continue;
      await goto(page, href);
      await expectNoSidewaysScroll(page, href);
    }
  });
});

test.describe("every portal screen fits a 375px phone", () => {
  test.use({ viewport: PHONE });

  test("no client-facing screen scrolls sideways", async ({ page }) => {
    test.setTimeout(COLD_COMPILE * 4);

    await signInAs(page, CLIENT, "/portal");

    for (const route of PORTAL_ROUTES) {
      await goto(page, route);
      await expectNoSidewaysScroll(page, route);
    }
  });
});
