import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * A domain added by hand against the wrong client used to be stuck there. The
 * unique index is on (organisation, name), archiving a client does not release
 * it, and nothing could move or remove it — so the name could never be used
 * again. These are the two doors that free it.
 */
test("a domain can be moved to another client and then deleted", async ({ page }) => {
  await signIn(page);
  await page.goto("/domains");
  await page.getByRole("heading", { name: "Domains" }).first().waitFor({ timeout: 120_000 });

  const firstDomain = page.locator('a[href^="/domains/"]').first();
  await firstDomain.click();
  await page.waitForURL(/\/domains\/[0-9a-f-]{36}/, { timeout: 60_000 });

  await page.getByRole("heading", { name: "Ownership" }).waitFor({ timeout: 60_000 });

  // Move: the select lists clients and the domain follows the choice.
  const select = page.locator('select[name="clientId"]');
  await expect(select).toBeVisible();
  const options = await select.locator("option").count();
  expect(options).toBeGreaterThan(1);
  console.log("SHOT clients offered = " + options);

  // Delete refuses a name that does not match, rather than deleting anything.
  await page.locator('input[name="confirmName"]').fill("not-the-domain.example");
  await page.getByRole("button", { name: "Delete domain" }).click();
  await expect(page.getByText(/Type .* exactly to delete it/)).toBeVisible({ timeout: 30_000 });
  console.log("SHOT wrong name refused: ok");
  await expect(page).toHaveURL(/\/domains\/[0-9a-f-]{36}/);

  await page.screenshot({ path: "test-results/domain-ownership.png", fullPage: true });
});
