import { expect, test } from "@playwright/test";
import { createDb, schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

const db = createDb(DATABASE_URL);

/**
 * One person, two Stripe subscriptions, one client row after a merge.
 *
 * The billing screen read `activeSubscriptionForClient`, which ends in
 * `limit(1)`: it showed the older subscription and hid the newer one, while
 * the portfolio KPI summed every row. Two screens, two numbers, no
 * explanation on either.
 */
test("two subscriptions on one client both show, with a total", async ({ page }) => {
  const [org] = await db.select().from(schema.organisations).limit(1);
  const [client] = await db.select().from(schema.clients)
    .where(eq(schema.clients.organisationId, org!.id)).limit(1);
  const [pkg] = await db.select().from(schema.packages)
    .where(eq(schema.packages.organisationId, org!.id)).limit(1);

  const period = {
    currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
  };
  const made = await db.insert(schema.subscriptions).values([
    { organisationId: org!.id, clientId: client!.id, packageId: pkg!.id, amountPence: 22000,
      stripeSubscriptionId: `sub_e2e_a_${Date.now()}`, ...period },
    { organisationId: org!.id, clientId: client!.id, packageId: pkg!.id, amountPence: 11000,
      stripeSubscriptionId: `sub_e2e_b_${Date.now()}`, ...period },
  ]).returning();

  try {
    await signIn(page);
    await page.goto(`/clients/${client!.id}`);
    await page.getByRole("heading", { name: "Subscription" }).first().waitFor({ timeout: 120_000 });

    const body = await page.locator("main").innerText();
    console.log("SHOT shows 220 = " + body.includes("220.00") + ", shows 110 = " + body.includes("110.00"));
    const totalLine = page.getByText(/\d+ active subscriptions/);
    await expect(totalLine).toBeVisible({ timeout: 30_000 });
    console.log("SHOT total line = " + (await totalLine.textContent()));
    console.log("SHOT shows combined 330 = " + body.includes("330.00"));
    await page.screenshot({ path: "test-results/two-subs.png", fullPage: true });
  } finally {
    for (const row of made) {
      await db.delete(schema.subscriptions).where(and(
        eq(schema.subscriptions.id, row.id), eq(schema.subscriptions.organisationId, org!.id),
      ));
    }
  }
});
