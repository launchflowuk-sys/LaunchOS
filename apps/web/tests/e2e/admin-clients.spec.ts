import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which takes
// far longer than the 5s default expect timeout on a cold start — tens of
// seconds per route on a loaded machine. The first assertion after each new
// route or server action gets a budget that covers that compile; every other
// assertion keeps the default.
const COLD_COMPILE = 90_000;

test("create a client, add a contact, save billing, add two domains and a site, then find it in search", async ({ page }) => {
  // This walk touches six routes and eight server actions, each compiled on
  // first use, which does not fit Playwright's 30s per-test default on a cold
  // dev server.
  test.setTimeout(180_000);

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
  // The generated support address shows exactly twice on the overview tab: in
  // the page header and in the "Client created" timeline entry. Asserting the
  // count rather than `.first()` catches a header or timeline that stops
  // rendering it.
  await expect(page.getByText(`e2e-client-${stamp}@`)).toHaveCount(2);

  await page.getByRole("link", { name: "Contacts & Billing" }).click();
  await page.getByLabel("Contact name").fill("Alex Contact");
  await page.getByLabel("Contact email").fill(`alex-${stamp}@example.test`);
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("cell", { name: "Alex Contact" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByLabel("Billing name").fill(`Billing ${stamp} Ltd`);
  await page.getByLabel("Billing postcode").fill("RM17 6BB");
  await page.getByRole("button", { name: "Save billing details" }).click();
  await expect(page.getByText("Billing details saved")).toBeVisible({ timeout: COLD_COMPILE });

  // The billing profile is upserted server-side, so it must survive a reload.
  await page.reload();
  await expect(page.getByLabel("Billing name")).toHaveValue(`Billing ${stamp} Ltd`, { timeout: COLD_COMPILE });
  await expect(page.getByLabel("Billing postcode")).toHaveValue("RM17 6BB");

  await page.getByRole("link", { name: "Sites & Domains" }).click();
  for (const suffix of ["one", "two"]) {
    await page.getByLabel("Domain name").fill(`${suffix}-${stamp}.example.test`);
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByRole("cell", { name: `${suffix}-${stamp}.example.test` })).toBeVisible({
      timeout: COLD_COMPILE,
    });
  }

  await page.getByLabel("Website name").fill(`site-${stamp}`);
  await page.getByLabel("Primary URL").fill(`https://one-${stamp}.example.test`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("cell", { name: `site-${stamp}` })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: COLD_COMPILE });
});
