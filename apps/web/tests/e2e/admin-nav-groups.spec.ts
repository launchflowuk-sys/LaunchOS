import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * Thirty-five entries in one column is longer than any phone and most laptops.
 * Groups fold; the one holding the current page is open because it holds it.
 *
 * The last assertion is the one worth having: a folded group must still be
 * able to shout. Approvals is where every outward action waits for a human, so
 * its count moves up to the group header when the group is closed — otherwise
 * folding the rail would quietly hide the most consequential number in the
 * product.
 */
test("nav groups fold, follow the current page, and keep their counts", async ({ page }) => {
  await signIn(page);
  await page.goto("/clients");
  const nav = page.locator('nav[aria-label="Main"]');
  await nav.waitFor({ timeout: 120_000 });

  const delivery = nav.locator("button[aria-expanded]", { hasText: "Delivery" });
  const money = nav.locator("button[aria-expanded]", { hasText: "Money" });

  // Arriving on /clients opens Delivery and nothing else.
  await expect(delivery).toHaveAttribute("aria-expanded", "true");
  await expect(money).toHaveAttribute("aria-expanded", "false");

  // Far fewer links than the thirty-five the flat rail showed.
  expect(await nav.locator("a:visible").count()).toBeLessThan(20);

  // A group opened by hand survives client-side navigation.
  await money.click();
  await expect(money).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("link", { name: "Invoices" }).click();
  await page.waitForURL("**/invoices", { timeout: 60_000 });
  await expect(nav.locator("button[aria-expanded]", { hasText: "Money" })).toHaveAttribute("aria-expanded", "true");

  // Automation is closed here, and its approvals count has to survive that.
  const automation = nav.locator("button[aria-expanded]", { hasText: "Automation" });
  await expect(automation).toHaveAttribute("aria-expanded", "false");
  await expect(automation).toContainText(/\d/);
});
