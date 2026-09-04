import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which takes
// far longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route or server action gets a budget that covers
// that compile; every other assertion keeps the default.
const COLD_COMPILE = 90_000;

test("add an ad account, walk its detail page, and reach ad reports, reports and Settings → Billing", async ({
  page,
}) => {
  // Six routes and one server action, each compiled on first use, which does
  // not fit Playwright's 30s per-test default on a cold dev server.
  test.setTimeout(240_000);

  const stamp = Date.now();
  const accountName = `E2E Ads ${stamp}`;

  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Ads", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ads" })).toBeVisible({ timeout: COLD_COMPILE });

  const form = page.getByRole("form", { name: "Add an ad account" });
  await form.getByLabel("Client").selectOption({ index: 1 });
  await form.getByLabel("Platform").selectOption("google");
  await form.getByLabel("Account id").fill(String(stamp));
  await form.getByLabel("Account name").fill(accountName);
  await form.getByRole("button", { name: "Add ad account" }).click();

  // The row proves the account was written and read back org-scoped; "steady"
  // proves computeAccountSignals ran for an account with no snapshots at all.
  const row = page.getByRole("row").filter({ hasText: accountName });
  await expect(row).toBeVisible({ timeout: COLD_COMPILE });
  await expect(row.getByText("steady")).toBeVisible();

  await page.getByRole("link", { name: accountName }).click();
  await expect(page.getByRole("heading", { name: accountName })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: "Last 7 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Previous 7 days" })).toBeVisible();
  await expect(page.getByText("No signals — this account is steady.")).toBeVisible();
  await expect(page.getByText("No daily metrics yet.")).toBeVisible();

  const adReports = await page.goto("/ads/reports");
  expect(adReports?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Ad reports" })).toBeVisible({ timeout: COLD_COMPILE });

  const reports = await page.goto("/reports");
  expect(reports?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible({ timeout: COLD_COMPILE });

  // The report detail route is org-scoped: an id this organisation does not
  // own is a 404, never another organisation's report and never a 500.
  const missing = await page.goto("/reports/00000000-0000-4000-8000-000000000000");
  expect(missing?.status()).toBe(404);

  const billing = await page.goto("/settings/billing");
  expect(billing?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: /Payments/ })).toBeVisible();
  await expect(page.getByText(/VAT rate \d+%/)).toBeVisible();
  // The point of the screen: which adapter is live and whether each secret is
  // present — never the secret itself.
  await expect(page.getByText("STRIPE_SECRET_KEY")).toBeVisible();
  await expect(page.getByText("Mock ingest is deterministic")).toBeVisible();
});

test("a client's Invoices and Reports tabs are routes of their own", async ({ page }) => {
  test.setTimeout(180_000);

  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });

  // The first cell of the first row is the client name link; the seed
  // guarantees at least one client.
  await page.getByRole("table").getByRole("link").first().click();
  const tabs = page.getByRole("main");
  await expect(tabs.getByRole("link", { name: "Invoices", exact: true })).toBeVisible({ timeout: COLD_COMPILE });

  await tabs.getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+\/invoices$/, { timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Raise invoice" })).toBeVisible();

  await tabs.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+\/reports$/, { timeout: COLD_COMPILE });
  await expect(page.getByText("No reports for this client yet.")).toBeVisible();
});
