import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { signIn } from "./sign-in";
import { DATABASE_URL } from "./seed-credentials";

// The dev server compiles a route the first time it is requested, which takes
// far longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route or server action gets a budget that covers
// that compile; every other assertion keeps the default.
const COLD_COMPILE = 90_000;

/**
 * Publishing is the one-way door on these screens — the client sees the far
 * side of it — and the seed writes no `client_reports` row, so the only way to
 * exercise `/reports/[id]` with data is to insert a draft the way the portal
 * spec does. It belongs to "Mobile PC Doctor" rather than the first client in
 * the list, so the client-tabs test below still sees an empty Reports tab, and
 * it is deleted again in `afterAll`.
 */
const db = createDb(DATABASE_URL);

const DRAFT_PERIOD = { start: "2098-07-01", end: "2098-07-31" } as const;
const DRAFT_PERIOD_LABEL = "1 Jul 2098 → 31 Jul 2098";
const DRAFT_CLIENT = "Mobile PC Doctor";
const DRAFT_SPEND_PENCE = 123_400;

let draftReportId: string;

test.beforeAll(async () => {
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisation.id), eq(schema.clients.name, DRAFT_CLIENT)));
  if (!client) throw new Error(`seed client "${DRAFT_CLIENT}" not found — run \`pnpm db:seed\` first`);

  // `uptimePercent: null` is the em dash the tile grid has to render; the two
  // money tiles are what the currency fix is about.
  const [draft] = await db
    .insert(schema.clientReports)
    .values({
      organisationId: organisation.id,
      clientId: client.id,
      periodStart: DRAFT_PERIOD.start,
      periodEnd: DRAFT_PERIOD.end,
      summaryMd: "# July 2098\n\nA draft report, written by the e2e spec.",
      status: "draft",
      stats: {
        tasksDone: 7,
        tasksOpen: 2,
        uptimePercent: null,
        ticketsOpened: 1,
        ticketsResolved: 1,
        ads: { spendPence: DRAFT_SPEND_PENCE, clicks: 10, conversions: 2, roas: 2.5 },
        invoices: { issued: 1, paidPence: 50_000, outstandingPence: 0 },
      },
    })
    .returning();
  draftReportId = draft!.id;
});

test.afterAll(async () => {
  if (draftReportId) await db.delete(schema.clientReports).where(eq(schema.clientReports.id, draftReportId));
});

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
  await expect(page.getByText("£0.00").first()).toBeVisible();

  // Editing exists so a mistyped currency is fixable in the portal rather than
  // with an UPDATE against production Postgres. The window cards re-render in
  // the new currency, which proves the value was written and read back.
  await page.getByText("Edit account").click();
  const edit = page.getByRole("form", { name: "Edit ad account" });
  await edit.getByLabel("Currency").fill("USD");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("US$0.00").first()).toBeVisible({ timeout: COLD_COMPILE });

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

test("a draft client report renders its tiles and publishes to the portal", async ({ page }) => {
  test.setTimeout(240_000);

  await signIn(page);

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible({ timeout: COLD_COMPILE });

  const row = page.getByRole("row").filter({ hasText: DRAFT_PERIOD_LABEL });
  await expect(row).toBeVisible();
  await expect(row.getByText("draft")).toBeVisible();

  await row.getByRole("link", { name: DRAFT_PERIOD_LABEL }).click();
  await expect(page).toHaveURL(`/reports/${draftReportId}`, { timeout: COLD_COMPILE });

  // The stat grid: a computed number, a money tile in the client's currency
  // (this client has no ad account, so the fallback is sterling), and the em
  // dash that stands in for a figure the builder could not compute.
  const tiles = page.getByRole("main");
  await expect(tiles.getByText("Tasks done")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(tiles.getByText("£1,234.00")).toBeVisible();
  await expect(tiles.getByText("£500.00")).toBeVisible();
  await expect(tiles.getByText("—", { exact: true }).first()).toBeVisible();

  // Publishing is the one-way door: the button only exists while the report is
  // a draft, and the badge replaces it once core has flipped the status.
  await page.getByRole("button", { name: "Publish" }).click();
  // Exact: the page also carries the "Published <date>…" line and the toast.
  await expect(page.getByText("published", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
  await expect(page.getByText(/Published .* and visible in the client portal/)).toBeVisible();

  const [after] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.id, draftReportId));
  expect(after!.status).toBe("published");
  expect(after!.publishedAt).not.toBeNull();
});

test("a malformed report or ad account id is a 404, not a 500", async ({ page }) => {
  test.setTimeout(120_000);

  await signIn(page);

  // A non-UUID segment used to reach Postgres and raise 22P02, which Next
  // renders as its 500 page. A bad URL is a 404, exactly like an unowned id.
  for (const path of ["/reports/latest", "/ads/undefined"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should be a 404`).toBe(404);
  }
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
  // Either state is correct — the seed publishes a report for its first client
  // and may not for another — so the assertion is that the tab rendered its own
  // screen, not that the client happens to have no reports.
  await expect(page.getByText("Monthly reports for this client.")).toBeVisible();
});
