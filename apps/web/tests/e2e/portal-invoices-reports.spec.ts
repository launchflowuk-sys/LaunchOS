import { createClientUser } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, desc, eq, ne } from "drizzle-orm";

/**
 * Plan 5 Task 13 acceptance for the portal's invoices and reports.
 *
 * The invoices, the ad snapshots and the published report all come from
 * `pnpm db:seed`. What the seed cannot give the test is a password it knows,
 * so — like the Plan 4 portal spec — it makes its own client user for "Grays
 * CabLine" and removes it again in `afterAll`. It also creates the two rows the
 * seed deliberately does not: a draft invoice for this client (never visible in
 * the portal) and a published report belonging to a different client (a 404).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://launchos:launchos@localhost:5432/launchos";

// The dev server compiles each portal route the first time it is requested,
// measured at up to 35s cold, so the first assertion on a new screen needs far
// longer than the 5s default.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const PORTAL_EMAIL = `portal.billing.${STAMP}@grayscabline.example`;
const DRAFT_NUMBER = `E2E-DRAFT-${STAMP}`;

let organisationId: string;
let clientId: string;
let otherClientId: string;
let portalUserId: string;
let portalPassword: string;

let visibleInvoiceNumber: string;
let draftInvoiceId: string;
let otherInvoiceId: string;
let ownReportId: string;
let otherReportId: string;

async function clientByName(name: string) {
  const [row] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, name)));
  if (!row) throw new Error(`seed client "${name}" not found — run \`pnpm db:seed\` first`);
  return row;
}

async function signInAsPortalUser(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PORTAL_EMAIL);
  await page.getByLabel("Password").fill(portalPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/portal", { timeout: COLD_COMPILE });
}

test.beforeAll(async () => {
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  clientId = (await clientByName("Grays CabLine")).id;
  otherClientId = (await clientByName("Mobile PC Doctor")).id;

  const created = await createClientUser(db, organisationId, {
    clientId,
    email: PORTAL_EMAIL,
    name: "Portal Billing Tester",
  });
  portalUserId = created.user.id;
  portalPassword = created.oneTimePassword;

  const [visible] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.clientId, clientId), ne(schema.invoices.status, "draft")))
    .orderBy(desc(schema.invoices.issuedAt))
    .limit(1);
  if (!visible) throw new Error("no seeded invoice for Grays CabLine — run `pnpm db:seed` first");
  visibleInvoiceNumber = visible.number;

  const [other] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.clientId, otherClientId), ne(schema.invoices.status, "draft")))
    .limit(1);
  if (!other) throw new Error("no seeded invoice for Mobile PC Doctor — run `pnpm db:seed` first");
  otherInvoiceId = other.id;

  const [report] = await db
    .select()
    .from(schema.clientReports)
    .where(and(eq(schema.clientReports.clientId, clientId), eq(schema.clientReports.status, "published")))
    .limit(1);
  if (!report) throw new Error("no published report for Grays CabLine — run `pnpm db:seed` first");
  ownReportId = report.id;

  // A draft invoice for this very client: it must not reach the portal at all.
  const [draft] = await db
    .insert(schema.invoices)
    .values({
      organisationId,
      clientId,
      number: DRAFT_NUMBER,
      status: "draft",
      dueAt: new Date(),
      subtotalPence: 10_000,
      vatPence: 2_000,
      totalPence: 12_000,
      lineItems: [{ description: "Draft line", quantity: 1, unitPence: 10_000 }],
    })
    .returning();
  draftInvoiceId = draft!.id;

  // A published report for a different client, to prove the id alone is not a key.
  const [foreign] = await db
    .insert(schema.clientReports)
    .values({
      organisationId,
      clientId: otherClientId,
      periodStart: "2019-01-01",
      periodEnd: "2019-01-31",
      summaryMd: `# Not yours ${STAMP}`,
      status: "published",
      publishedAt: new Date(),
    })
    .returning();
  otherReportId = foreign!.id;
});

test.afterAll(async () => {
  if (draftInvoiceId) await db.delete(schema.invoices).where(eq(schema.invoices.id, draftInvoiceId));
  if (otherReportId) await db.delete(schema.clientReports).where(eq(schema.clientReports.id, otherReportId));
  // client_users and account cascade from user.
  if (portalUserId) await db.delete(schema.user).where(eq(schema.user.id, portalUserId));
});

test.describe("portal invoices and reports", () => {
  test("a client sees their sent invoices, never a draft, and can print one", async ({ page }) => {
    test.setTimeout(300_000);

    await signInAsPortalUser(page);
    await page.getByRole("navigation").getByRole("link", { name: "Invoices" }).click();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible({ timeout: COLD_COMPILE });

    await expect(page.getByRole("link", { name: visibleInvoiceNumber })).toBeVisible();
    // Drafts have not been agreed with the client and must never leak here.
    await expect(page.getByText(DRAFT_NUMBER)).toHaveCount(0);

    await page.getByRole("link", { name: visibleInvoiceNumber }).click();
    await expect(page.getByText(`Invoice ${visibleInvoiceNumber}`)).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Billed to")).toBeVisible();
    await expect(page.getByText("Grays CabLine")).toHaveCount(2); // portal header + bill-to block
    await expect(page.getByText("Subtotal")).toBeVisible();
    await expect(page.getByText("Total", { exact: true })).toBeVisible();
    await expect(page.getByText(/Payment terms: \d+ days\./)).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to invoices" })).toBeVisible();
  });

  test("a client reads a published report", async ({ page }) => {
    test.setTimeout(300_000);

    await signInAsPortalUser(page);
    await page.getByRole("navigation").getByRole("link", { name: "Reports" }).click();
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible({ timeout: COLD_COMPILE });

    await page.getByRole("cell").first().getByRole("link").click();
    // The stat cards sit above the Markdown summary, whose own H1 names the client.
    await expect(page.getByText("Tasks done")).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Tickets resolved")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Grays CabLine —/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/portal/reports/${ownReportId}$`));
  });

  test("another client's invoice or report id is a 404, and so is a draft", async ({ page }) => {
    test.setTimeout(300_000);

    await signInAsPortalUser(page);

    for (const path of [
      `/portal/invoices/${otherInvoiceId}`,
      `/portal/invoices/${draftInvoiceId}`,
      `/portal/reports/${otherReportId}`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} must 404`).toBe(404);
    }
    await expect(page.getByText(`Not yours ${STAMP}`)).toHaveCount(0);
  });
});
