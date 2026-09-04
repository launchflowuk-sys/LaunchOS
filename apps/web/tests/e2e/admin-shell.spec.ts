import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("the shell links every nav entry, offers Account, and search finds a seeded client", async ({ page }) => {
  await signIn(page);

  const nav = page.getByRole("navigation");
  for (const label of ["Clients", "Websites", "Domains", "Tasks", "Team"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  // Every module has landed, so nothing in the sidebar is a disabled "arrives
  // in Plan N" label any more — Inbox and Email were the last two to become
  // links, and this is what would catch a nav entry added ahead of its route.
  await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Email" })).toBeVisible();
  await expect(nav.getByText("Plan", { exact: false })).toHaveCount(0);

  // Outside the nav landmark, in the identity block: the member's own account.
  await expect(page.getByRole("link", { name: "Account" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search" }).fill("Grays");
  await expect(page.getByRole("link", { name: /Grays CabLine/ }).first()).toBeVisible();

  await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
});
