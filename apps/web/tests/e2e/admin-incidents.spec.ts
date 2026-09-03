import { expect, test } from "@playwright/test";

test("owner signs in and sees the incidents table", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk");
  await page.getByLabel("Password").fill(process.env.SEED_OWNER_PASSWORD ?? "change-me-now");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sign-in form redirects to the dashboard once the session cookie is set;
  // navigating before that lands back on /sign-in.
  await page.waitForURL("/");
  await page.goto("/incidents");
  await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
});
