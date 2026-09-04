import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk");
  await page.getByLabel("Password").fill(process.env.SEED_OWNER_PASSWORD ?? "change-me-now");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The form redirects once the session cookie is set; navigating earlier lands back on /sign-in.
  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
