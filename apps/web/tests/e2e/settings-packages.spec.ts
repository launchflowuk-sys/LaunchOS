import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * A settings list where every row is a full open form is unreadable at eight
 * rows. The rows collapse to a name; the form is still there when you open it.
 *
 * The assertion that matters is the last one: a collapsed row must still hold
 * its real values, because the fields post with the form whether or not a
 * person has expanded them.
 */
test("packages list collapses to names and opens on click", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/packages");
  await page.getByRole("heading", { name: "Existing packages" }).waitFor({ timeout: 120_000 });

  const row = page.locator('details:has(summary:has-text("/growth"))');
  await expect(row).toHaveCount(1);

  expect(await row.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

  await row.locator("summary").click();
  await expect.poll(() => row.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

  // Open, the row is the same editable form it always was.
  await expect(row.locator("input[name=name]")).toHaveValue("Growth");
  await expect(row.locator("button[type=submit]")).toBeVisible();

  await row.locator("summary").click();
  await expect.poll(() => row.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

  // Closed, the values are still in the DOM and would still post.
  await expect(row.locator("input[name=name]")).toHaveValue("Growth");
});
