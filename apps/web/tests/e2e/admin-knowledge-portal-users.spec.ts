import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which can
// take longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route gets a budget that covers that compile.
const COLD_COMPILE = 30_000;

/** A word Postgres tokenises as one lexeme, so `plainto_tsquery` matches it exactly. */
function uniqueWord(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`;
}

test("write a knowledge article, preview it, publish it and find it with search", async ({ page }) => {
  // Four routes and two server actions, each compiled on first use, which does
  // not fit Playwright's 30s per-test default on a cold dev server.
  test.setTimeout(180_000);

  const token = uniqueWord("zephyrine");
  const title = `E2E Article ${token}`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Knowledge Base" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("link", { name: "New article" }).click();
  await expect(page.getByRole("heading", { name: "New article" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Tags").fill(`e2e, ${token}`);
  await page.getByLabel("Article body").fill(`# Heading ${token}\n\nHow to fix ${token} on a client site.`);

  // Preview renders the Markdown rather than the source, and switching back
  // keeps what was typed.
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: `Heading ${token}` })).toBeVisible();
  await page.getByRole("button", { name: "Write" }).click();
  await expect(page.getByLabel("Article body")).toHaveValue(new RegExp(token));

  await page.getByLabel("Published").check();
  await page.getByRole("button", { name: "Create article" }).click();

  // Redirected to the article's own page, pre-filled and ready to edit.
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("Published")).toBeChecked();

  await page.getByRole("navigation").getByRole("link", { name: "Knowledge Base" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: COLD_COMPILE });

  // Full-text search finds it by a word that appears only in this article.
  await page.getByLabel("Search articles").fill(token);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("link", { name: title })).toHaveCount(1);
});

test("invite a portal user from a client and see the one-time password exactly once", async ({ page }) => {
  test.setTimeout(180_000);

  const email = `e2e-portal-${Date.now()}@example.test`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Grays CabLine" }).click();
  await expect(page.getByRole("heading", { name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });

  // The Support tab is enabled by this plan, so the client's own support
  // address is reachable without leaving the client.
  await page.getByRole("link", { name: "Support", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Support address" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("link", { name: "Portal users" }).click();
  await expect(page.getByRole("heading", { name: "Portal users" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("E2E Portal User");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Create portal user" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible({ timeout: COLD_COMPILE });
  await expect(password).not.toHaveText("");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});
