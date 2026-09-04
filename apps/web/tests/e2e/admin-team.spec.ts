import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("add a team member and see the one-time password exactly once", async ({ page }) => {
  const email = `e2e-staff-${Date.now()}@example.test`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Full name").fill("E2E Staff");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Create member" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible();
  await expect(password).not.toHaveText("");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
});
