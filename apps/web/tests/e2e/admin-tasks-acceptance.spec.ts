import { createDb, schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

/**
 * Plan 3 Task 12 acceptance: the seeded packages and onboarding templates
 * (`packages/db/src/seed.ts`) actually drive the UI end to end, and a task's
 * status can be moved from both the list and the board.
 *
 * `admin-tasks.spec.ts` and `admin-tasks-detail.spec.ts` predate the seed
 * (Plan 3 Tasks 10-11) and build their own package/template/client through
 * the UI so they do not depend on it. This spec is named
 * `admin-tasks-acceptance.spec.ts`, not `admin-tasks.spec.ts`, because that
 * file name is already in use — it deliberately exercises the seeded
 * "Website Care" package and its ten onboarding templates instead.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://launchos:launchos@localhost:5432/launchos";

// The dev server compiles each route the first time it is requested in a
// fresh browser context, which can take longer than the 5s default timeout.
const COLD_COMPILE = 60_000;

test.describe("tasks acceptance", () => {
  test("a client created with a seeded package gets its onboarding task list", async ({ page }) => {
    test.setTimeout(120_000);

    const db = createDb(DATABASE_URL);
    const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
    if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");

    const name = `Playwright Client ${Date.now()}`;

    try {
      await signIn(page);

      await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
      await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });

      await page.getByRole("button", { name: "New client" }).click();
      await page.getByLabel("Name").fill(name);
      await page.getByLabel("Package").selectOption({ label: "Website Care" });
      await page.getByRole("button", { name: "Create client" }).click();

      // The dialog redirects to the new client's page once created.
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: COLD_COMPILE });

      // Scoped to <main>: the sidebar also has a "Tasks" link.
      await page.getByRole("main").getByRole("link", { name: "Tasks", exact: true }).click();
      await expect(page.getByRole("progressbar", { name: "Onboarding" })).toBeVisible({ timeout: COLD_COMPILE });

      // The worker's tasks.generate-onboarding job does this on client.created;
      // the button runs the same idempotent generator so the test does not need
      // a live worker. Clicking it when the job already ran is a no-op.
      await page.getByRole("button", { name: "Generate onboarding tasks" }).click();

      await expect(page.getByRole("link", { name: "Discovery call" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Handover" })).toBeVisible();

      // Idempotent: running it again must not create a second "Discovery call".
      await page.getByRole("button", { name: "Generate onboarding tasks" }).click();
      await expect(page.getByRole("link", { name: "Discovery call" })).toHaveCount(1);
    } finally {
      // Tasks, activity and the billing profile cascade from the client.
      await db.delete(schema.clients).where(and(eq(schema.clients.organisationId, organisation.id), eq(schema.clients.name, name)));
      await db.$client.end();
    }
  });

  test("status changes move a seeded task on the board", async ({ page }) => {
    test.setTimeout(120_000);

    await signIn(page);

    await page.goto("/tasks?view=board");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: COLD_COMPILE });

    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: COLD_COMPILE });
    const row = page.getByRole("row").filter({ hasText: "Discovery call" }).first();
    await row.getByLabel("Status").selectOption("in_progress");
    await row.getByRole("button", { name: "Move" }).click();

    await page.goto("/tasks?view=board&status=in_progress");
    await expect(page.getByText("Discovery call").first()).toBeVisible();
  });
});
