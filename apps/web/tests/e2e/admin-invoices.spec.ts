import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which takes
// far longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route or server action gets a budget that covers
// that compile; every other assertion keeps the default.
const COLD_COMPILE = 90_000;

test("raise an invoice, send it through approvals, mark it paid, then record a payment", async ({ page }) => {
  // Eight routes and seven server actions, each compiled on first use. A cold
  // `next dev` spends most of the walk compiling, which does not fit
  // Playwright's 30s per-test default — measured at ~5 minutes cold, well under
  // a minute warm.
  test.setTimeout(600_000);

  const stamp = Date.now();
  await signIn(page);

  await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Grays CabLine" }).click();
  await expect(page.getByRole("heading", { name: "Grays CabLine" })).toBeVisible({ timeout: COLD_COMPILE });
  const clientUrl = page.url().split("?")[0]!;

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
  const invoiceUrl = page.url();

  const number = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
  // `LF-<year>-<seq>` — see INVOICE_NUMBER_PREFIX in packages/core.
  expect(number).toMatch(/^LF-\d{4}-\d{4}$/);
  // £99.00 subtotal plus 20% VAT.
  await expect(page.getByText("£118.80").first()).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Send…" })).toBeVisible();

  // The approval gate: Send… must not email anybody by itself, and approving
  // must actually send rather than only stamping the approval row.
  await page.getByRole("button", { name: "Send…" }).click();
  await expect(page.getByText("Send queued for approval")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("awaiting approval before it is emailed")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Send…" })).toBeHidden();

  await page.getByRole("navigation").getByRole("link", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible({ timeout: COLD_COMPILE });
  const approval = page.getByRole("listitem").filter({ hasText: `Send invoice ${number}` }).first();
  await expect(approval).toBeVisible({ timeout: COLD_COMPILE });
  await approval.getByRole("form", { name: "Approve approval" }).getByRole("button", { name: "Approve" }).click();
  // The decision landed and reads as approved. /approvals keeps decided
  // approvals on the page but moves them out of the "waiting for you" cards and
  // into an "already decided" list, so this is looked for in that row rather
  // than in the card, which is gone. It has to be a *positive* signal: the
  // invoice is only sent once this server action has finished, and asserting
  // the card's absence would pass the moment it disappears and race the send.
  await expect(
    page.getByRole("row").filter({ hasText: `Send invoice ${number}` }).getByText("approved", { exact: true }),
  ).toBeVisible({ timeout: COLD_COMPILE });

  await page.goto(invoiceUrl);
  await expect(page.getByRole("heading", { name: number })).toBeVisible({ timeout: COLD_COMPILE });
  // The status badge is the send having happened: `sendApprovedInvoice` only
  // reaches `sent` after the email adapter has accepted the message.
  await expect(page.locator("dt", { hasText: /^Status$/ }).locator("xpath=following-sibling::dd[1]"))
    .toHaveText("sent");
  await expect(page.getByText("awaiting approval before it is emailed")).toBeHidden();

  // ...and the send is visible in the client's activity feed. The verb is
  // matched loosely ("emailed to" / "queued to") because it follows whichever
  // delivery path core takes; the invoice, the recipient and the fact that a
  // send happened at all are what this asserts.
  await page.goto(clientUrl);
  await expect(page.getByText(new RegExp(`Invoice ${number} \\w+ to info@grayscabline\\.co\\.uk`)))
    .toBeVisible({ timeout: COLD_COMPILE });

  await page.goto(invoiceUrl);
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
  // By accessible name, not by label text. The field is a wrapping
  // `<label>Client<select>…</select></label>`, and Playwright's label text for a
  // wrapping label is the whole element's text — every `<option>` included — so
  // `getByLabel("Client", { exact: true })` matches nothing. Dropping `exact`
  // is no good either: matching is a case-insensitive substring, and the
  // Invoice field's "Choose a client first" option makes it two matches.
  await page.getByRole("combobox", { name: "Client", exact: true }).selectOption({ label: "Grays CabLine" });
  await page.getByLabel("Amount (£)").fill("118.80");
  await page.getByLabel("Provider").selectOption("bank");
  await page.getByLabel("Reference").fill(reference);
  await page.getByRole("button", { name: "Record payment", exact: true }).last().click();

  await expect(page.getByText("Payment recorded")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("cell", { name: reference })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("row", { name: new RegExp(reference) }).getByText("£118.80")).toBeVisible();
});
