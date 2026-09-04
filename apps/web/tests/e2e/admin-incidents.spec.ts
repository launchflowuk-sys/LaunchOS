import { expect, test } from "@playwright/test";
import { OWNER } from "./seed-credentials";

test("owner signs in and sees the incidents table", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sign-in form redirects to the dashboard once the session cookie is set;
  // navigating before that lands back on /sign-in.
  await page.waitForURL("/");
  await page.goto("/incidents");
  await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
});
