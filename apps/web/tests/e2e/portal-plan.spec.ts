import { createClient, createClientUser, ukLongDate } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, sql } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The client portal's Plan page and the approval-gated change request behind it.
 *
 * The spec makes a client of its own — with a package, an active subscription
 * and a portal user — rather than borrowing the seeded "Grays CabLine": the
 * happy path *cancels* the subscription, and cancelling the seed's would leave
 * every later run (and every other portal spec) looking at a dead plan.
 * Everything it creates hangs off the client row and is deleted in `afterAll`;
 * the approval and its audit rows are removed by id.
 */
// The dev server compiles each route the first time it is requested, measured
// at up to 35s cold, so the first assertion on a new screen gets far longer
// than the 5s default.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const CLIENT_NAME = `E2E Plan Client ${STAMP}`;
const PACKAGE_NAME = `E2E Growth ${STAMP}`;
const PORTAL_EMAIL = `portal.plan.${STAMP}@e2e.example`;
const REASON = `We are closing the office in October (${STAMP}).`;
const PERIOD_END = new Date(Date.UTC(2027, 0, 31, 12, 0, 0));

let organisationId: string;
let clientId: string;
let packageId: string;
let subscriptionId: string;
let portalUserId: string;
let portalPassword: string;
let ownerUserId: string;

async function signInAsPortalUser(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PORTAL_EMAIL);
  await page.getByLabel("Password").fill(portalPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/portal", { timeout: COLD_COMPILE });
}

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [owner] = await db
    .select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.role, "owner")))
    .limit(1);
  if (!owner) throw new Error("seed owner not found — run `pnpm db:seed` first");
  ownerUserId = owner.userId;

  const client = await createClient(db, organisationId, { name: CLIENT_NAME, email: `office.${STAMP}@e2e.example` });
  clientId = client.id;

  const [pkg] = await db
    .insert(schema.packages)
    .values({
      organisationId,
      name: PACKAGE_NAME,
      slug: `e2e-growth-${STAMP}`,
      monthlyPricePence: 14_900,
      setupPricePence: 0,
      includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
    })
    .returning();
  packageId = pkg!.id;

  const [subscription] = await db
    .insert(schema.subscriptions)
    .values({
      organisationId,
      clientId,
      packageId,
      status: "active",
      currentPeriodStart: new Date(Date.UTC(2027, 0, 1)),
      currentPeriodEnd: PERIOD_END,
      amountPence: 14_900,
      currency: "GBP",
      stripeSubscriptionId: `e2e_sub_${STAMP}`,
    })
    .returning();
  subscriptionId = subscription!.id;

  const created = await createClientUser(db, organisationId, { clientId, email: PORTAL_EMAIL, name: "Plan Tester" });
  portalUserId = created.user.id;
  portalPassword = created.oneTimePassword;
});

test.afterAll(async () => {
  if (clientId) {
    // Approvals are keyed to the client only through their payload.
    const approvals = await db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(sql`${schema.approvals.payload}->>'clientId' = ${clientId}`);
    for (const approval of approvals) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, approval.id));
      await db.delete(schema.approvals).where(eq(schema.approvals.id, approval.id));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, subscriptionId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, clientId));
    await db.delete(schema.notifications).where(sql`${schema.notifications.body} like ${`%${CLIENT_NAME}%`}`);
    // Subscriptions, conversations (and their messages), activity and the
    // client_users row cascade from the client.
    await db.delete(schema.clients).where(eq(schema.clients.id, clientId));
  }
  if (packageId) await db.delete(schema.packages).where(eq(schema.packages.id, packageId));
  if (portalUserId) await db.delete(schema.user).where(eq(schema.user.id, portalUserId));
});

test.describe("client portal plan", () => {
  test("shows the package, takes a cancel request, the owner approves it and the portal says so", async ({ page, browser }) => {
    test.setTimeout(420_000);

    // 1. The plan, in the client's words.
    await signInAsPortalUser(page);
    await page.getByRole("navigation").getByRole("link", { name: "Plan" }).click();
    await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText(PACKAGE_NAME)).toBeVisible();
    await expect(page.getByText("£149.00")).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText(ukLongDate(PERIOD_END))).toBeVisible();
    await expect(page.getByText("4 social posts a month")).toBeVisible();
    await expect(page.getByText("1 blog post a month")).toBeVisible();
    await expect(page.getByText("2 Google Business Profile updates a month")).toBeVisible();

    // 2. Ask to cancel.
    await page.getByLabel("What would you like to do?").selectOption("cancel");
    await page.getByLabel("Tell us more").fill(REASON);
    await page.getByRole("button", { name: "Send request" }).click();

    const pendingBox = page.getByTestId("plan-change-pending");
    await expect(pendingBox).toBeVisible({ timeout: COLD_COMPILE });
    await expect(pendingBox).toContainText("Request sent — LaunchFlow will confirm");
    await expect(pendingBox).toContainText("Cancel my plan");
    await expect(pendingBox.getByRole("button", { name: "Request sent" })).toBeDisabled();
    // The form is gone: one request at a time.
    await expect(page.getByRole("button", { name: "Send request" })).toHaveCount(0);

    const [approval] = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, organisationId), sql`${schema.approvals.payload}->>'clientId' = ${clientId}`));
    expect(approval!.kind).toBe("subscription_change");
    expect(approval!.status).toBe("pending");
    expect(approval!.runId).toBeNull();
    expect(approval!.payload).toMatchObject({ kind: "cancel", message: REASON, clientName: CLIENT_NAME });

    // 3. The owner sees it in Approvals and approves it.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    try {
      await signIn(admin);
      await admin.getByRole("navigation").getByRole("link", { name: "Approvals" }).click();
      await expect(admin.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible({ timeout: COLD_COMPILE });

      const card = admin.locator(`li[data-approval-id="${approval!.id}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(CLIENT_NAME);
      await expect(card).toContainText("Cancel my plan");
      await expect(card).toContainText(REASON);
      await expect(card).toContainText("subscription change");
      await expect(card.getByRole("link", { name: CLIENT_NAME })).toHaveAttribute("href", `/clients/${clientId}`);

      const approveForm = card.getByRole("form", { name: "Approve approval" });
      await approveForm.locator('input[name="note"]').fill("Sorry to see you go.");
      await approveForm.getByRole("button", { name: "Approve" }).click();
      await expect(admin.getByText("Decision recorded", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
      await expect(card).toHaveCount(0);
    } finally {
      await adminContext.close();
    }

    // 4. The decision was carried out: the subscription is cancelled, the
    //    decision is audited, and the portal user has a courtesy email queued.
    const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval!.id));
    expect(decided!.status).toBe("approved");
    expect(decided!.decidedBy).toBe(ownerUserId);
    expect(decided!.metadata["appliedAt"]).toEqual(expect.any(String));

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(subscription!.status).toBe("cancelled");
    expect(subscription!.metadata["cancelAtPeriodEnd"]).toBe(PERIOD_END.toISOString());

    const notices = await db
      .select()
      .from(schema.messages)
      .where(and(
        eq(schema.messages.organisationId, organisationId),
        sql`${schema.messages.metadata}->>'approvalId' = ${approval!.id}`,
      ));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.toEmail).toBe(PORTAL_EMAIL);
    expect(notices[0]!.subject).toBe("Your request has been approved");
    expect(["queued", "sent"]).toContain(notices[0]!.status);

    // 5. The portal shows the answer and the plan's new state.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByText("Your request was approved")).toBeVisible();
    await expect(page.getByText("Sorry to see you go.")).toBeVisible();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(page.getByText("Ends on")).toBeVisible();
    await expect(page.getByTestId("plan-change-pending")).toHaveCount(0);
  });

  test("a client with no plan is told so and pointed at Support", async ({ page }) => {
    test.setTimeout(240_000);

    // Move the subscription out of the way, then put it back for anyone after us.
    await db.update(schema.subscriptions).set({ deletedAt: new Date() }).where(eq(schema.subscriptions.id, subscriptionId));
    try {
      await signInAsPortalUser(page);
      await page.goto("/portal/plan");
      await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible({ timeout: COLD_COMPILE });
      await expect(page.getByText("No plan set up yet")).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to Support" })).toHaveAttribute("href", "/portal/support");
    } finally {
      await db.update(schema.subscriptions).set({ deletedAt: null }).where(eq(schema.subscriptions.id, subscriptionId));
    }
  });
});
