import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which takes
// far longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route or server action gets a budget that covers
// that compile; every other assertion keeps the default.
const COLD_COMPILE = 90_000;

test("start a subscription, raise an invoice, mark it paid, then record a payment", async ({ page }) => {
  // Six routes and five server actions, each compiled on first use, which does
  // not fit Playwright's 30s per-test default on a cold dev server.
  test.setTimeout(240_000);

  const stamp = Date.now();
  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Grays CabLine" }).click();
  await expect(page.getByRole("heading", { name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("link", { name: "Contacts & Billing" }).click();
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible({ timeout: COLD_COMPILE });

  // The seed ships no subscription, but a previous run of this spec leaves one
  // behind — the section shows the start form only while there is none active.
  const startForm = page.getByRole("form", { name: "Start a subscription" });
  if (await startForm.isVisible()) {
    await startForm.getByLabel("Package").selectOption({ label: "Website Care — £99.00 a month" });
    await startForm.getByRole("button", { name: "Start subscription" }).click();
  }
  await expect(page.getByRole("button", { name: "Raise invoice" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("button", { name: "Raise invoice" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: COLD_COMPILE });

  const number = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
  expect(number).toMatch(/^INV-/);
  // £99.00 subtotal plus 20% VAT.
  await expect(page.getByText("£118.80").first()).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Send…" })).toBeVisible();

  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByText("Invoice marked paid")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Mark paid" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Send…" })).toBeHidden();

  await page.getByRole("navigation").getByRole("link", { name: "Invoices" }).click();
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible({ timeout: COLD_COMPILE });
  // The filter labels are lower-cased in the DOM and title-cased by CSS, so the
  // accessible name differs between browsers — match either.
  await page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: /^paid$/i }).click();
  await expect(page.getByRole("link", { name: number })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("navigation").getByRole("link", { name: "Payments" }).click();
  await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible({ timeout: COLD_COMPILE });

  const reference = `e2e-${stamp}`;
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Client").selectOption({ label: "Grays CabLine" });
  await page.getByLabel("Amount (£)").fill("118.80");
  await page.getByLabel("Provider").selectOption("bank");
  await page.getByLabel("Reference").fill(reference);
  await page.getByRole("button", { name: "Record payment", exact: true }).last().click();

  await expect(page.getByText("Payment recorded")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("cell", { name: reference })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("row", { name: new RegExp(reference) }).getByText("£118.80")).toBeVisible();
});
