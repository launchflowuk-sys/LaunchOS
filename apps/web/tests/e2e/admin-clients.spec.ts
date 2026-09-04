import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which can
// take longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route (and after the first /api/search call) gets a
// budget that covers that compile; every other assertion keeps the default.
const COLD_COMPILE = 30_000;

test("create a client, add a contact, two domains and a site, then find it in search", async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E Client ${stamp}`;

  await signIn(page);
  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("button", { name: "New client" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`e2e-${stamp}@example.test`);
  await page.getByLabel("Phone").fill("01375 000000");
  await page.getByLabel("Address line 1").fill("1 High Street");
  await page.getByLabel("City").fill("Grays");
  await page.getByLabel("Postcode").fill("RM17 6AA");
  await page.getByRole("button", { name: "Create client" }).click();

  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: COLD_COMPILE });
  // The generated support address shows twice on the overview tab: in the page
  // header and in the "Client created" timeline entry.
  await expect(page.getByText(`e2e-client-${stamp}@`).first()).toBeVisible();

  await page.getByRole("link", { name: "Contacts & Billing" }).click();
  await page.getByLabel("Contact name").fill("Alex Contact");
  await page.getByLabel("Contact email").fill(`alex-${stamp}@example.test`);
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("cell", { name: "Alex Contact" })).toBeVisible();

  await page.getByRole("link", { name: "Sites & Domains" }).click();
  for (const suffix of ["one", "two"]) {
    await page.getByLabel("Domain name").fill(`${suffix}-${stamp}.example.test`);
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByRole("cell", { name: `${suffix}-${stamp}.example.test` })).toBeVisible();
  }

  await page.getByLabel("Website name").fill(`site-${stamp}`);
  await page.getByLabel("Primary URL").fill(`https://one-${stamp}.example.test`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("cell", { name: `site-${stamp}` })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: COLD_COMPILE });
});
