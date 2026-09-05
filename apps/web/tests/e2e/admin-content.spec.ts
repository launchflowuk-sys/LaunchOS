import { activeSubscriptionForClient, CHANNEL_LABEL } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The content engine from the owner's side: plan a month from the seeded
 * client's package, write one of the slots, send it for approval, approve it
 * in Approvals, and see it come back approved.
 *
 * It plans a month far in the future rather than the current one so it never
 * collides with a real plan (or the worker's first-of-the-month cron) on the
 * seeded client, and removes every row it made in `afterAll`. Planning is
 * idempotent, so a run that died half-way leaves nothing a second run trips on.
 */
// The dev server compiles each route the first time it is requested, measured
// at up to 35s cold, so the first assertion on a new screen gets far longer
// than the 5s default.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const PERIOD = "2031-03";
const TITLE = `E2E post ${STAMP}`;
const BODY = `Book your airport run with Grays CabLine — fixed prices, drivers who know the roads. (${STAMP})`;

let organisationId: string;
let clientId: string;
/** How many slots the seeded package plans in a month: social + blog + GBP. */
let expectedSlots: number;

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;

  const [client] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, "Grays CabLine")));
  if (!client) throw new Error("seeded client Grays CabLine not found — run `pnpm db:seed` first");
  clientId = client.id;

  // The seed decides which package Grays CabLine is on; the spec reads the
  // quotas rather than assuming them, so a seed change does not break it.
  const subscription = await activeSubscriptionForClient(db, organisationId, clientId);
  if (!subscription?.packageId) throw new Error("seeded client has no active subscription — run `pnpm db:seed` first");
  const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, subscription.packageId));
  const includes = pkg!.includes;
  expectedSlots = includes.socialPostsPerMonth + includes.blogPostsPerMonth + includes.gbpUpdatesPerMonth;
  if (expectedSlots === 0) throw new Error("seeded package plans no content — nothing to test");
});

test.afterAll(async () => {
  if (!clientId) return;
  const items = await db
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.clientId, clientId), eq(schema.contentItems.periodKey, PERIOD)));
  const itemIds = items.map((item) => item.id);
  if (itemIds.length === 0) return;

  const approvals = await db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(inArray(sql`${schema.approvals.payload}->>'itemId'`, itemIds));
  const approvalIds = approvals.map((approval) => approval.id);

  await db.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, [...itemIds, ...approvalIds]));
  for (const id of itemIds) {
    await db.delete(schema.activityEvents).where(like(schema.activityEvents.link, `/content/${id}%`));
    await db.delete(schema.notifications).where(like(schema.notifications.link, `/content/${id}%`));
  }
  // The item points at its approval; clear the pointer before the approval goes.
  await db.update(schema.contentItems).set({ approvalId: null }).where(inArray(schema.contentItems.id, itemIds));
  if (approvalIds.length > 0) await db.delete(schema.approvals).where(inArray(schema.approvals.id, approvalIds));
  await db.delete(schema.contentItems).where(inArray(schema.contentItems.id, itemIds));
});

test.describe("admin content", () => {
  test("plans a month, edits a slot, sends it for approval and approves it", async ({ page }) => {
    test.setTimeout(420_000);

    // 1. The Content screen, from the rail.
    await signIn(page);
    await page.getByRole("navigation").getByRole("link", { name: "Content" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Content" })).toBeVisible({ timeout: COLD_COMPILE });

    // 2. Plan a far-future month for the seeded client from its package.
    await page.goto(`/content?period=${PERIOD}&client=${clientId}`);
    await expect(page.getByRole("heading", { level: 2, name: "March 2031" })).toBeVisible({ timeout: COLD_COMPILE });
    const planner = page.getByRole("form", { name: "Plan a month" });
    await expect(planner.getByLabel("Client")).toHaveValue(clientId);
    await expect(planner.getByLabel("Month")).toHaveValue(PERIOD);
    await planner.getByRole("button", { name: "Plan this month" }).click();
    await expect(page.getByText(/Planned \d+ slots? for the month|The month was already planned/)).toBeVisible({ timeout: COLD_COMPILE });

    const table = page.getByRole("table", { name: "Content for March 2031" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(expectedSlots + 1); // header + the slots
    await expect(table.getByText("draft").first()).toBeVisible();

    const planned = await db
      .select({ id: schema.contentItems.id, channel: schema.contentItems.channel, status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.clientId, clientId), eq(schema.contentItems.periodKey, PERIOD)));
    expect(planned).toHaveLength(expectedSlots);
    expect(planned.every((item) => item.status === "draft")).toBe(true);
    // A social slot when the package has one, otherwise whatever was planned first.
    const slot = planned.find((item) => item.channel === "facebook") ?? planned[0]!;
    const label = CHANNEL_LABEL[slot.channel];

    // 3. Write the slot.
    await page.goto(`/content/${slot.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `${label} slot` })).toBeVisible({ timeout: COLD_COMPILE });

    const editor = page.getByRole("form", { name: "Edit post" });
    await editor.getByLabel("Title").fill(TITLE);
    await editor.getByLabel("Text").fill(BODY);
    await editor.getByLabel("Link").fill("https://grayscabline.co.uk/airport-transfers");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible({ timeout: COLD_COMPILE });

    // 4. Send it for approval: the item parks, the approval card exists.
    await page.getByRole("form", { name: "Send for approval" }).getByRole("button", { name: "Send for approval" }).click();
    await expect(page.getByText("Sent for approval", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.locator('[data-status="awaiting_approval"]')).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("button", { name: "Send for approval" })).toHaveCount(0);

    const [approval] = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, organisationId), sql`${schema.approvals.payload}->>'itemId' = ${slot.id}`));
    expect(approval!.kind).toBe("content_publish");
    expect(approval!.status).toBe("pending");
    expect(approval!.runId).toBeNull();
    expect(approval!.title).toContain(`Publish ${label} for Grays CabLine`);

    // 5. Approve it in Approvals. The card is the post itself.
    await page.getByRole("navigation").getByRole("link", { name: "Approvals" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible({ timeout: COLD_COMPILE });

    const card = page.locator(`li[data-approval-id="${approval!.id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Grays CabLine");
    await expect(card).toContainText(label);
    await expect(card).toContainText(BODY);
    await expect(card).toContainText("content publish");
    await expect(card.getByRole("link", { name: "Edit" })).toHaveAttribute("href", `/content/${slot.id}`);

    const approveForm = card.getByRole("form", { name: "Approve approval" });
    await approveForm.locator('input[name="note"]').fill("Good to go.");
    await approveForm.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Decision recorded", { exact: true })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(card).toHaveCount(0);

    // 6. The decision landed on the item.
    const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval!.id));
    expect(decided!.status).toBe("approved");
    expect(decided!.metadata["appliedAt"]).toEqual(expect.any(String));

    const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, slot.id));
    expect(item!.status).toBe("approved");
    expect(item!.title).toBe(TITLE);
    expect(item!.body).toBe(BODY);
    expect(item!.scheduledFor).not.toBeNull();

    await page.goto(`/content/${slot.id}`);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.locator('[data-status="approved"]')).toBeVisible();
    await expect(page.getByRole("form", { name: "Edit post" })).toHaveCount(0);
    await expect(page.getByText(BODY)).toBeVisible();

    // 7. And the list shows it approved, filtered to the month.
    await page.goto(`/content?period=${PERIOD}&client=${clientId}&status=approved`);
    const approvedTable = page.getByRole("table", { name: "Content for March 2031" });
    await expect(approvedTable).toBeVisible({ timeout: COLD_COMPILE });
    await expect(approvedTable.getByRole("row")).toHaveCount(2);
    await expect(approvedTable).toContainText(TITLE);
  });
});
