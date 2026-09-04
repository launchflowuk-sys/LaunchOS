import { expect, type Page } from "@playwright/test";
import { OWNER } from "./seed-credentials";

export async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The form redirects once the session cookie is set; navigating earlier lands back on /sign-in.
  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
