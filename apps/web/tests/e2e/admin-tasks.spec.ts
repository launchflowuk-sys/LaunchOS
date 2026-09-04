import { createDb, schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://launchos:launchos@localhost:5432/launchos";
const SEEDED_CLIENT_NAME = "Grays CabLine";

test("tasks: create from the dialog, filter, move on the board, and count on the dashboard", async ({ page }) => {
  // Two views, five server actions and a first-visit dev compile of /tasks; the
  // default 30s budget is not enough on a cold dev server.
  test.setTimeout(120_000);

  // No packages or tasks are seeded yet (Plan 3 Task 12), so this spec creates
  // the task it needs through the UI and removes it again afterwards.
  const db = createDb(DATABASE_URL);
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");

  const title = `E2E task ${Date.now()}`;

  try {
    await signIn(page);

    await expect(page.getByText("Overdue tasks")).toBeVisible();
    await expect(page.getByText("Due this week")).toBeVisible();
    await expect(page.getByText("Onboarding in progress")).toBeVisible();

    await page.getByRole("navigation").getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: 60_000 });

    // Create.
    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('select[name="clientId"]').selectOption({ label: SEEDED_CLIENT_NAME });
    await dialog.locator('input[name="title"]').fill(title);
    await dialog.locator('select[name="priority"]').selectOption("high");
    await dialog.getByRole("button", { name: "Create task" }).click();

    const row = page.getByRole("row", { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(row.getByText(SEEDED_CLIENT_NAME)).toBeVisible();

    // Filter: a status the task is not in hides it, and the filter survives in the URL.
    const filters = page.getByRole("form", { name: "Task filters" });
    await filters.locator('select[name="status"]').selectOption("done");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/status=done/);
    await expect(page.getByRole("row", { name: new RegExp(title) })).toHaveCount(0);

    await filters.locator('select[name="status"]').selectOption("todo");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("row", { name: new RegExp(title) })).toBeVisible();

    // Board: the card starts in "todo" and the status form moves it.
    await page.getByRole("link", { name: "Board view" }).click();
    await expect(page).toHaveURL(/view=board/);
    const todo = page.getByRole("region", { name: "todo" });
    await expect(todo.getByText(title)).toBeVisible();

    // The status filter is still todo — clear it so the moved card stays on screen.
    await filters.locator('select[name="status"]').selectOption("");
    await filters.getByRole("button", { name: "Apply" }).click();

    const card = page.getByRole("article").filter({ hasText: title });
    await card.locator('select[name="status"]').selectOption("in_progress");
    await card.getByRole("button", { name: "Move" }).click();

    await expect(page.getByRole("region", { name: "in progress" }).getByText(title)).toBeVisible();
    await expect(page.getByRole("region", { name: "todo" }).getByText(title)).toHaveCount(0);
  } finally {
    await db
      .delete(schema.tasks)
      .where(and(eq(schema.tasks.organisationId, organisation.id), eq(schema.tasks.title, title)));
    await db.$client.end();
  }
});
