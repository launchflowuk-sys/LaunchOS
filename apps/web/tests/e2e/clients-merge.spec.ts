import { createClient, createContact } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * Two records for one business become one: the owner opens the duplicate,
 * picks the client to keep, reads what moves, types the kept name and
 * merges. The duplicate then wears the "Merged into" banner and the kept
 * client has the moved contact. Then the Stripe review page, on the mock
 * payments adapter seeded through the dev-only hook: a customer nobody
 * knows gets a "File under" select with the kept client suggested by email
 * domain; filing it there and importing lists the client under "Filed under
 * existing clients", and the subscription and payment account sit on it.
 *
 * `afterAll` removes both clients (contacts, billing profiles, payment
 * accounts and subscriptions cascade), the package the import created, the
 * audit/activity/notification rows, puts the organisation's Stripe-sync
 * metadata back as it was, and clears the mock's seed.
 */
const COLD_COMPILE = 120_000;
const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const DOMAIN = `tilbury-e2e-${STAMP}.example`;
const KEEP_NAME = `E2E Keep Me ${STAMP}`;
const MERGE_NAME = `E2E Duplicate ${STAMP}`;
const CONTACT_NAME = `Moved Contact ${STAMP}`;
const CUSTOMER_ID = `cus_e2e_${STAMP}`;
const CUSTOMER_EMAIL = `accounts@${DOMAIN}`;
const SUBSCRIPTION_ID = `sub_e2e_${STAMP}`;
const PRODUCT_ID = `prod_e2e_${STAMP}`;
const PRODUCT_NAME = `LaunchFlow E2E Hosting ${STAMP}`;

let organisationId: string;
let organisationMetadata: Record<string, unknown>;
let keepId: string;
let mergeId: string;

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;
  organisationMetadata = organisation.metadata;

  const keep = await createClient(db, organisationId, { name: KEEP_NAME, email: `hello@${DOMAIN}`, actorKind: "system" });
  keepId = keep.id;
  const merge = await createClient(db, organisationId, { name: MERGE_NAME, notes: `Duplicate made by the e2e run ${STAMP}.`, actorKind: "system" });
  mergeId = merge.id;
  await createContact(db, organisationId, { clientId: merge.id, name: CONTACT_NAME, email: `moved.${STAMP}@${DOMAIN}`, actorKind: "system" });
});

test.afterAll(async () => {
  if (!organisationId) return;
  const ids = [keepId, mergeId].filter((id): id is string => Boolean(id));
  if (ids.length > 0) await db.delete(schema.clients).where(inArray(schema.clients.id, ids));
  await db.delete(schema.packages).where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.stripeProductId, PRODUCT_ID)));
  await db.update(schema.organisations).set({ metadata: organisationMetadata }).where(eq(schema.organisations.id, organisationId));
  if (ids.length > 0) await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, ids));
  const marker = `%${STAMP}%`;
  await db.delete(schema.activityEvents).where(like(schema.activityEvents.title, marker));
  await db.delete(schema.notifications).where(or(like(schema.notifications.title, marker), like(schema.notifications.body, marker)));
});

test("the owner merges a duplicate into the client they keep, and both pages say so", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto(`/clients/${mergeId}`);
  await expect(page.getByRole("heading", { name: MERGE_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Merge into another client…" }).click();

  // Step one: the searchable picker. The search narrows the native select; the choice travels as ?keep=.
  await expect(page.getByRole("heading", { name: `Merge ${MERGE_NAME}` })).toBeVisible({ timeout: COLD_COMPILE });
  const keepSelect = page.getByLabel("Client to keep");
  await expect(keepSelect.locator("option")).not.toHaveCount(1);
  await page.getByLabel("Search clients").fill(`E2E Keep Me ${STAMP}`);
  await expect(keepSelect.locator("option")).toHaveCount(2);
  await keepSelect.selectOption(keepId);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step two: the preview in plain words, the button off until the name is typed.
  await expect(page.getByRole("heading", { name: `Merge ${MERGE_NAME} into ${KEEP_NAME}` })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("Moves to the kept client")).toBeVisible();
  await expect(page.getByText(/1 contact/)).toBeVisible();
  const mergeButton = page.getByRole("button", { name: `Merge ${MERGE_NAME} into ${KEEP_NAME}` });
  await expect(mergeButton).toBeDisabled();
  // Typed before hydration, the name is in the DOM but not in the form's state, so the button stays off: fill until it takes.
  await expect(async () => {
    await page.getByLabel(`Type "${KEEP_NAME}" to confirm`).fill(KEEP_NAME);
    await expect(mergeButton).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: COLD_COMPILE });
  await mergeButton.click();

  // Lands on the kept client with the toast; the contact is now theirs.
  await page.waitForURL(`**/clients/${keepId}`, { timeout: COLD_COMPILE });
  await expect(page.getByText(`Merged ${MERGE_NAME} into ${KEEP_NAME}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: KEEP_NAME })).toBeVisible();
  await expect(page.getByText(`Merged "${MERGE_NAME}" into this client`)).toBeVisible();
  await page.goto(`/clients/${keepId}?tab=contacts`);
  await expect(page.getByText(CONTACT_NAME).first()).toBeVisible({ timeout: COLD_COMPILE });

  // The duplicate is archived and points at where everything went.
  await page.goto(`/clients/${mergeId}`);
  await expect(page.getByRole("heading", { name: MERGE_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  const banner = page.getByRole("note").filter({ hasText: "Merged into" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: KEEP_NAME })).toHaveAttribute("href", `/clients/${keepId}`);
  await expect(page.getByRole("link", { name: "Merge into another client…" })).toHaveCount(0);

  const [merged] = await db.select().from(schema.clients).where(eq(schema.clients.id, mergeId));
  expect(merged).toMatchObject({ status: "archived" });
  expect(merged!.metadata["mergedInto"]).toBe(keepId);
  const contacts = await db.select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, keepId));
  expect(contacts.map((c) => c.name)).toContain(CONTACT_NAME);
  // Notes were carried across under the merge heading.
  const [kept] = await db.select().from(schema.clients).where(eq(schema.clients.id, keepId));
  expect(kept!.notes).toContain(`Merged from "${MERGE_NAME}"`);
});

test("the Stripe review offers File under for an unknown customer and files it under the chosen client", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  // Seed the dev server's mock adapter: one product, one subscription for a customer LaunchOS has never seen.
  const seeded = await page.request.post("/api/dev/mock-payments", {
    data: {
      catalog: [{ priceId: `price_e2e_${STAMP}`, productId: PRODUCT_ID, productName: PRODUCT_NAME, amountPence: 4900 }],
      subscriptions: [{
        id: SUBSCRIPTION_ID, customerId: CUSTOMER_ID, customerEmail: CUSTOMER_EMAIL, customerName: `Tilbury Taxis Ltd ${STAMP}`,
        priceId: `price_e2e_${STAMP}`, productId: PRODUCT_ID, amountPence: 4900,
        currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdAt: new Date().toISOString(),
      }],
    },
    timeout: COLD_COMPILE,
  });
  test.skip(seeded.status() === 409, "the dev server is on a real payments adapter, not the mock");
  expect(seeded.status()).toBe(200);

  try {
    await page.goto("/settings/billing/stripe");
    await expect(page.getByRole("heading", { name: "Review Stripe import" })).toBeVisible({ timeout: COLD_COMPILE });
    // Role queries: DataList keeps a hidden second tree in the DOM, and only the visible one is in the accessibility tree.
    await expect(page.getByRole("checkbox", { name: `Import ${PRODUCT_NAME}` })).toBeChecked();

    // The select defaults to a new client named from Stripe, and suggests the kept client by its email domain.
    const fileUnder = page.getByRole("combobox", { name: `File under for ${CUSTOMER_EMAIL}` });
    await expect(fileUnder).toHaveValue("new");
    await expect(fileUnder.locator("optgroup[label='Suggested'] option", { hasText: KEEP_NAME })).toHaveCount(1);
    await expect(fileUnder.locator("optgroup[label='Suggested'] option", { hasText: KEEP_NAME })).toHaveText(new RegExp(`same email domain \\(${DOMAIN}\\)`));
    await expect(page.getByRole("textbox", { name: `Client name for ${CUSTOMER_EMAIL}` })).toHaveValue(`Tilbury Taxis Ltd ${STAMP}`);
    await fileUnder.selectOption(keepId);
    await expect(page.getByRole("textbox", { name: `Client name for ${CUSTOMER_EMAIL}` })).toHaveCount(0);
    await expect(page.getByText("Files under this client; the Stripe customer becomes one of its payment accounts").first()).toBeVisible();

    await page.getByRole("button", { name: "Import selected" }).click();
    await page.waitForURL("**/settings/billing/stripe/result", { timeout: COLD_COMPILE });
    await expect(page.getByRole("heading", { name: "Stripe import" })).toBeVisible();
    const filed = page.locator("section", { hasText: "Filed under existing clients" });
    await expect(filed.getByRole("link", { name: KEEP_NAME })).toHaveAttribute("href", `/clients/${keepId}/billing`);
    await expect(page.locator("section", { hasText: "Clients created" }).getByText("No new clients this run.")).toBeVisible();

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, SUBSCRIPTION_ID));
    expect(subscription).toMatchObject({ clientId: keepId, status: "active", amountPence: 4900 });
    const [account] = await db.select().from(schema.clientPaymentAccounts).where(eq(schema.clientPaymentAccounts.externalCustomerId, CUSTOMER_ID));
    expect(account).toMatchObject({ clientId: keepId, email: CUSTOMER_EMAIL });

    // Back on the review, the customer is now known by id: no select, just the client.
    await page.goto("/settings/billing/stripe");
    await expect(page.getByRole("heading", { name: "Review Stripe import" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("combobox", { name: `File under for ${CUSTOMER_EMAIL}` })).toHaveCount(0);
    await expect(page.getByText("Matched by Stripe customer id").first()).toBeVisible();
  } finally {
    await page.request.post("/api/dev/mock-payments", { data: {} });
  }
});
