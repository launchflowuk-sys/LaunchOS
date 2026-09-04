import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

test("the shell shows the grouped nav, later plans disabled, and search finds a seeded client", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("navigation").getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Websites" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Domains" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Team" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("navigation").getByText("Inbox")).toHaveAttribute("title", "Arrives in Plan 4");

  await page.getByRole("searchbox", { name: "Search" }).fill("Grays");
  await expect(page.getByRole("link", { name: /Grays CabLine/ }).first()).toBeVisible();

  await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
});
