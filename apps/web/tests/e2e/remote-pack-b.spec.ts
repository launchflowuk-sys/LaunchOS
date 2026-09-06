import { createLead, createPackage, deleteContentAsset, listContentAssets, updatePackage } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * Remote pack, web half B: the public lead intake feeding the Leads page and
 * "Convert to client"; the self-serve sign-up through the mock payments
 * adapter to /signup/done; a photo into a client's image library and served
 * back from the public asset route.
 *
 * Beyond the seed it makes a package with a Stripe price id (so sign-up takes
 * the Checkout path) and removes everything it made in `afterAll`: the
 * package, the leads, the signed-up client (cascades to its subscription,
 * billing profile, portal user row and tasks), that user's account, and the
 * audit, activity and notification rows behind them.
 *
 * `PUBLIC_FORMS_TOKEN` must be in the repo-root `.env` the dev server was
 * started with for the intake test to hit the route for real; without it the
 * lead is written directly and the token test asserts the 503 instead.
 */
const COLD_COMPILE = 120_000;
const FORMS_TOKEN = process.env.PUBLIC_FORMS_TOKEN?.trim() || null;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const LEAD_BUSINESS = `Tilbury Taxis ${STAMP}`;
const LEAD_NAME = `Remote Pack Lead ${STAMP}`;
const LEAD_MESSAGE = `We need a new website for the taxi firm (${STAMP}).`;
const PACKAGE_NAME = `E2E Signup ${STAMP}`;
const PACKAGE_SLUG = `e2e-signup-${STAMP}`;
const SIGNUP_BUSINESS = `Purfleet Salon ${STAMP}`;
const SIGNUP_EMAIL = `signup.remote-b.${STAMP}@purfleet.example`;
const PHOTO_ALT = `The van outside the office ${STAMP}`;

/** A real 1×1 PNG so the grid's `<img>` renders rather than showing a broken icon. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let organisationId: string;
let clientId: string;
let packageId: string;
let leadId: string;
let convertedClientId: string | null = null;
let signupClientId: string | null = null;
let assetId: string | null = null;

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [client] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, "Grays CabLine")));
  if (!client) throw new Error("seed client Grays CabLine not found — run `pnpm db:seed` first");
  clientId = client.id;

  // A package that sells online: the Stripe price id is what sends sign-up
  // through Checkout (the mock completes it on retrieve).
  const pkg = await createPackage(db, organisationId, {
    name: PACKAGE_NAME,
    slug: PACKAGE_SLUG,
    description: "Hosting and a monthly post, for the e2e run.",
    monthlyPricePence: 4900,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 2, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 },
  });
  packageId = pkg.id;
  await updatePackage(db, organisationId, { packageId, stripePriceId: `price_e2e_${STAMP}` });
});

test.afterAll(async () => {
  if (!organisationId) return;
  if (assetId) await deleteContentAsset(db, organisationId, { assetId }).catch(() => undefined);
  const clientIds = [convertedClientId, signupClientId].filter((id): id is string => Boolean(id));
  if (clientIds.length > 0) await db.delete(schema.clients).where(inArray(schema.clients.id, clientIds));
  await db.delete(schema.user).where(eq(schema.user.email, SIGNUP_EMAIL));
  await db.delete(schema.leads).where(and(eq(schema.leads.organisationId, organisationId), or(eq(schema.leads.name, LEAD_NAME), eq(schema.leads.email, SIGNUP_EMAIL))));
  if (packageId) await db.delete(schema.packages).where(eq(schema.packages.id, packageId));
  const targets = [leadId, packageId, assetId, ...clientIds].filter((id): id is string => Boolean(id));
  if (targets.length > 0) await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, targets));
  const marker = `%${STAMP}%`;
  await db.delete(schema.activityEvents).where(like(schema.activityEvents.title, marker));
  await db.delete(schema.notifications).where(or(like(schema.notifications.title, marker), like(schema.notifications.body, marker)));
});

test("the public lead route refuses a wrong token (or says it is switched off)", async ({ request }) => {
  const res = await request.post("/api/public/leads", {
    headers: { "x-public-forms-token": "not-the-token" },
    data: { name: "Nobody" },
    timeout: COLD_COMPILE,
  });
  expect(res.status()).toBe(FORMS_TOKEN ? 401 : 503);
});

test("a website lead is listed on /leads and converted to a client", async ({ page, request }) => {
  test.setTimeout(300_000);

  if (FORMS_TOKEN) {
    const res = await request.post("/api/public/leads", {
      headers: { "x-public-forms-token": FORMS_TOKEN },
      data: { name: LEAD_NAME, business: LEAD_BUSINESS, email: `lead.${STAMP}@tilbury.example`, phone: "07700 900123", message: LEAD_MESSAGE, page: "/contact" },
      timeout: COLD_COMPILE,
    });
    expect(res.status()).toBe(200);
    leadId = ((await res.json()) as { id: string }).id;
  } else {
    const lead = await createLead(db, organisationId, {
      name: LEAD_NAME, business: LEAD_BUSINESS, email: `lead.${STAMP}@tilbury.example`, message: LEAD_MESSAGE, source: "website", actorKind: "client",
    });
    leadId = lead.id;
  }

  await signIn(page);
  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible({ timeout: COLD_COMPILE });
  const row = page.getByRole("link", { name: LEAD_BUSINESS }).first();
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.getByRole("heading", { name: LEAD_BUSINESS })).toBeVisible({ timeout: COLD_COMPILE });
  // Exact: the owner's `lead.created` bell carries the same text in its body.
  await expect(page.getByText(LEAD_MESSAGE, { exact: true })).toBeVisible();
  await expect(page.getByText("Website form").first()).toBeVisible();

  // Status by hand first, then the conversion.
  // Exact: the form's own aria-label ("Change status") contains the word too.
  await page.getByLabel("Status", { exact: true }).selectOption("contacted");
  await page.getByRole("button", { name: "Save status" }).click();
  await expect(page.getByText("Status saved")).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    const [lead] = await db.select({ status: schema.leads.status }).from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead?.status).toBe("contacted");
  }).toPass({ timeout: 15_000 });

  const convert = page.getByRole("form", { name: "Convert to client" });
  await expect(convert.getByLabel("Client name")).toHaveValue(LEAD_BUSINESS);
  await convert.getByLabel("Package", { exact: true }).selectOption({ label: PACKAGE_NAME });
  await convert.getByRole("button", { name: "Convert to client" }).click();
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/, { timeout: COLD_COMPILE });
  convertedClientId = page.url().split("/clients/")[1]!;

  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId));
  expect(lead?.status).toBe("converted");
  expect(lead?.clientId).toBe(convertedClientId);
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, convertedClientId));
  expect(client?.name).toBe(LEAD_BUSINESS);
  expect(client?.packageId).toBe(packageId);
  await expect(page.getByRole("heading", { name: LEAD_BUSINESS })).toBeVisible({ timeout: COLD_COMPILE });
});

test("sign-up lists packages and the mock checkout lands on /signup/done", async ({ page }) => {
  test.setTimeout(300_000);
  await page.context().clearCookies();
  await page.goto(`/signup?package=${PACKAGE_SLUG}`);
  await expect(page.getByRole("heading", { name: "Sign up to LaunchFlow" })).toBeVisible({ timeout: COLD_COMPILE });

  // The card, pre-selected from the query string, says it sells by card.
  const card = page.getByRole("radio", { name: new RegExp(PACKAGE_NAME) });
  await expect(card).toBeChecked();
  await expect(page.getByText("£49.00").first()).toBeVisible();
  await expect(page.getByText("pay by card, cancel any time.").first()).toBeVisible();

  await page.getByLabel("Your name").fill("Remote Pack Buyer");
  await page.getByLabel("Business name").fill(SIGNUP_BUSINESS);
  await page.getByLabel("Email").fill(SIGNUP_EMAIL);
  await page.getByLabel("Phone (optional)").fill("07700 900456");
  await page.getByRole("button", { name: "Continue to payment" }).click();

  // Mock payments: the Checkout "hosted page" is the success URL itself, and
  // retrieving the session on /signup/done completes it.
  await page.waitForURL(/\/signup\/done\?session_id=/, { timeout: COLD_COMPILE });
  await expect(page.getByText("You're in")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, SIGNUP_BUSINESS)));
  expect(client).toBeDefined();
  signupClientId = client!.id;
  expect(client!.packageId).toBe(packageId);
  const [lead] = await db.select().from(schema.leads).where(and(eq(schema.leads.organisationId, organisationId), eq(schema.leads.email, SIGNUP_EMAIL)));
  expect(lead?.source).toBe("signup");
  expect(lead?.status).toBe("converted");
  expect(lead?.clientId).toBe(signupClientId);
  const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.clientId, signupClientId));
  expect(subscription?.status).toBe("active");
  const [portalUser] = await db.select().from(schema.clientUsers).where(eq(schema.clientUsers.clientId, signupClientId));
  expect(portalUser?.role).toBe("client_admin");

  // Coming back to the same session is idempotent: still welcomed, no second client.
  await page.reload();
  await expect(page.getByText("You're in")).toBeVisible({ timeout: COLD_COMPILE });
  const twins = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.name, SIGNUP_BUSINESS));
  expect(twins).toHaveLength(1);
});

test("a photo uploaded to the library appears in the grid and is served from /api/assets", async ({ page, request }) => {
  test.setTimeout(300_000);
  await page.context().clearCookies();
  await signIn(page);
  await page.goto(`/clients/${clientId}/content`);
  await expect(page.getByRole("heading", { name: "Image library" })).toBeVisible({ timeout: COLD_COMPILE });

  const form = page.getByRole("form", { name: "Add a photo" });
  await form.getByLabel("Photo").setInputFiles({ name: `van-${STAMP}.png`, mimeType: "image/png", buffer: PNG_1X1 });
  await form.getByLabel("Alt text (optional)").fill(PHOTO_ALT);
  await form.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByText("Photo added to the library")).toBeVisible({ timeout: 30_000 });

  const tile = page.getByRole("img", { name: PHOTO_ALT });
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: `Delete ${PHOTO_ALT}` })).toBeVisible();

  const assets = await listContentAssets(db, organisationId, { clientId });
  const mine = assets.find((asset) => asset.alt === PHOTO_ALT);
  expect(mine).toBeDefined();
  assetId = mine!.id;
  expect(mine!.originalName).toBe(`van-${STAMP}.png`);
  expect(mine!.sizeBytes).toBe(PNG_1X1.byteLength);

  // Public, cookie-less, cached for a year: what Meta and WordPress will fetch.
  const served = await request.get(`/api/assets/${assetId}`, { headers: { cookie: "" }, timeout: COLD_COMPILE });
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(served.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(Buffer.from(await served.body()).equals(PNG_1X1)).toBe(true);
});
