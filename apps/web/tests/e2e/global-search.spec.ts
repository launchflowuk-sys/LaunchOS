import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * The platform search in the top bar.
 *
 * It is the one control that reaches every record in the product, so it earns
 * a test of its own: type, get grouped results, press Enter, land on the
 * record. The keyboard path is asserted because it is the path a person who
 * uses this all day will actually take.
 */

const COLD_COMPILE = 120_000;

test("the top-bar search finds a client and opens it from the keyboard", async ({ page }) => {
  test.setTimeout(COLD_COMPILE * 2);
  await signIn(page);

  // Two instances render — the phone one lives on its own row under the bar —
  // and only the one for this viewport is visible.
  const search = page.getByRole("combobox", { name: "Search the whole platform" }).and(page.locator(":visible"));
  await search.click();
  await search.fill("grays");

  const results = page.locator("#global-search-results");
  await expect(results).toBeVisible({ timeout: 20_000 });
  await expect(results.getByText("Clients", { exact: true })).toBeVisible();

  const links = results.getByRole("link");
  const firstHref = await links.first().getAttribute("href");
  const secondHref = await links.nth(1).getAttribute("href");
  expect(firstHref).toBeTruthy();

  // The first row is highlighted the moment results arrive, so Enter alone
  // opens it — nobody should have to press Down before Return to reach the
  // top hit. ArrowDown therefore moves to the *second* row, which is what the
  // second half of this test pins down.
  await search.press("ArrowDown");
  await search.press("Enter");
  await page.waitForURL(`**${secondHref}`, { timeout: COLD_COMPILE });
  // The panel must not survive the navigation it caused.
  await expect(results).toHaveCount(0);

  const searchAgain = page.getByRole("combobox", { name: "Search the whole platform" }).and(page.locator(":visible"));
  await searchAgain.click();
  await searchAgain.fill("grays");
  await expect(page.locator("#global-search-results")).toBeVisible({ timeout: 20_000 });
  await searchAgain.press("Enter");
  await page.waitForURL(`**${firstHref}`, { timeout: COLD_COMPILE });
});

test("⌘K focuses the search from anywhere on the page", async ({ page }) => {
  test.setTimeout(COLD_COMPILE);
  await signIn(page);

  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+KeyK");

  const search = page.getByRole("combobox", { name: "Search the whole platform" }).and(page.locator(":visible"));
  await expect(search).toBeFocused();
});
