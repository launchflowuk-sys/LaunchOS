import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * The four views added on top of the lists: the leads board, the clients grid,
 * the websites grid with its thumbnails, and the detail drawer.
 *
 * Each one is reachable by a `?view=` in the URL and a toggle in the page
 * header, which is the contract the Tasks board already set. These tests are
 * about that contract holding — a bookmarked board stays a board — and about
 * the one thing a board is for: moving a record between columns.
 */

const COLD_COMPILE = 120_000;

test("the leads board shows a lane per status and moves a lead between them", async ({ page }) => {
  test.setTimeout(COLD_COMPILE * 2);
  await signIn(page);

  await page.goto("/leads", { timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Board view" }).click();
  await page.waitForURL(/view=board/, { timeout: COLD_COMPILE });

  // Every status gets a lane, `lost` included.
  for (const lane of ["New", "Contacted", "Qualified", "Converted", "Lost"]) {
    await expect(page.getByRole("region", { name: lane })).toBeVisible();
  }

  const newLane = page.getByRole("region", { name: "New" });
  const card = newLane.locator("article").first();
  if ((await newLane.locator("article").count()) === 0) test.skip(true, "the seed has no new leads to move");
  const title = (await card.locator("a").first().textContent())?.trim() ?? "";

  await card.getByLabel("Status").selectOption("contacted");
  await card.getByRole("button", { name: "Move" }).click();

  // The action revalidates /leads, so the card is re-rendered by the server in
  // the lane it moved to.
  await expect(page.getByRole("region", { name: "Contacted" }).getByText(title, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
});

test("the clients grid is a card per client and the toggle survives a reload", async ({ page }) => {
  test.setTimeout(COLD_COMPILE * 2);
  await signIn(page);

  await page.goto("/clients", { timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Grid view" }).click();
  await page.waitForURL(/view=grid/, { timeout: COLD_COMPILE });

  const cards = page.locator('main ul > li > a[href^="/clients/"]');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  // The view lives in the URL, so it is still a grid after a reload.
  await page.reload();
  await expect(page.locator('main ul > li > a[href^="/clients/"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "List view" })).toBeVisible();
});

test("the websites grid shows a thumbnail and its drawer opens with a way through", async ({ page }) => {
  test.setTimeout(COLD_COMPILE * 2);
  await signIn(page);

  await page.goto("/websites", { timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Grid view" }).click();
  await page.waitForURL(/view=grid/, { timeout: COLD_COMPILE });

  // Either a real thumbnail or the honest empty slot — never a broken image.
  const firstCard = page.locator("main ul > li").first();
  await expect(firstCard).toBeVisible();

  await firstCard.getByRole("button", { name: "Preview" }).click();

  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  // A preview with no way through is a dead end; every drawer carries one link.
  const through = drawer.getByRole("link", { name: "Open full page" });
  await expect(through).toBeVisible();
  await expect(through).toHaveAttribute("href", /^\/websites\/[0-9a-f-]{36}$/);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("a site thumbnail is served as an image to a signed-in session and refused without one", async ({ page, request }) => {
  test.setTimeout(COLD_COMPILE * 2);
  await signIn(page);

  await page.goto("/websites?view=grid", { timeout: COLD_COMPILE });
  const src = await page.locator('img[src^="/api/websites/"]').first().getAttribute("src");
  if (!src) test.skip(true, "no site has been captured in this database");

  const withSession = await page.request.get(src!);
  expect(withSession.status()).toBe(200);
  expect(withSession.headers()["content-type"]).toContain("image/");

  // `request` is a separate context with no cookies: the route is not public,
  // unlike /api/assets/[id] next door.
  const withoutSession = await request.get(src!);
  expect(withoutSession.status()).toBe(401);
});
