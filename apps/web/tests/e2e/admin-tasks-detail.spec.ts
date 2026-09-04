import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { signIn } from "./sign-in";
import { DATABASE_URL } from "./seed-credentials";

// The dev server compiles each route the first time it is requested. This spec
// walks four routes that have never been compiled before, so the first
// assertion after each gets a budget that covers the compile.
const COLD_COMPILE = 60_000;

test("packages, templates, generated onboarding tasks and the task detail screen", async ({ page }) => {
  test.setTimeout(300_000);

  // Nothing is seeded for Plan 3 yet (Task 12 does that), so this spec builds
  // the package, template and client it needs through the UI and removes them
  // again afterwards.
  const db = createDb(DATABASE_URL);
  const [organisation] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");

  const stamp = Date.now();
  const packageName = `E2E Care ${stamp}`;
  const packageSlug = `e2e-care-${stamp}`;
  const templateTitle = `Discovery call ${stamp}`;
  const clientName = `E2E Tasks Client ${stamp}`;
  const comment = `Kicked off on ${stamp}`;

  try {
    await signIn(page);

    // 1. A package, with the monthly quantities that drive recurring work.
    await page.getByRole("navigation").getByRole("link", { name: "Packages" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Packages" })).toBeVisible({ timeout: COLD_COMPILE });

    const newPackage = page.getByRole("form", { name: "New package" });
    await newPackage.locator('input[name="name"]').fill(packageName);
    await newPackage.locator('input[name="slug"]').fill(packageSlug);
    await newPackage.locator('input[name="monthlyPricePence"]').fill("19900");
    await newPackage.locator('input[name="blogPostsPerMonth"]').fill("1");
    await newPackage.locator('input[name="gbpUpdatesPerMonth"]').fill("2");
    await newPackage.locator('input[name="website"]').check();
    await newPackage.getByRole("button", { name: "Create package" }).click();

    const savedPackage = page.getByRole("form", { name: `Package ${packageName}` });
    await expect(savedPackage).toBeVisible();
    await expect(savedPackage.locator('input[name="blogPostsPerMonth"]')).toHaveValue("1");
    await expect(savedPackage.locator('input[name="gbpUpdatesPerMonth"]')).toHaveValue("2");

    // 2. An onboarding template for that package, with a two-line checklist.
    await page.getByRole("navigation").getByRole("link", { name: "Task templates" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Task templates" })).toBeVisible({ timeout: COLD_COMPILE });

    const newTemplate = page.getByRole("form", { name: "New template" });
    await newTemplate.locator('input[name="title"]').fill(templateTitle);
    await newTemplate.locator('select[name="phase"]').selectOption("onboarding");
    await newTemplate.locator('select[name="packageId"]').selectOption({ label: packageName });
    await newTemplate.locator('select[name="kind"]').selectOption("review");
    await newTemplate.locator('input[name="offsetDays"]').fill("1");
    await newTemplate.locator('input[name="sortOrder"]').fill("10");
    await newTemplate.locator('textarea[name="checklist"]').fill("Book the call\nSend the agenda");
    await newTemplate.getByRole("button", { name: "Create template" }).click();

    const savedTemplate = page.getByRole("form", { name: `Template ${templateTitle}`, exact: true });
    await expect(savedTemplate).toBeVisible();
    await expect(savedTemplate.locator('input[name="sortOrder"]')).toHaveValue("10");
    await expect(savedTemplate.locator('textarea[name="checklist"]')).toHaveValue("Book the call\nSend the agenda");

    // 3. A client on that package.
    await page.getByRole("navigation").getByRole("link", { name: "Clients" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible({ timeout: COLD_COMPILE });
    await page.getByRole("button", { name: "New client" }).click();
    await page.getByLabel("Name").fill(clientName);
    await page.getByLabel("Package").selectOption({ label: packageName });
    await page.getByRole("button", { name: "Create client" }).click();
    await expect(page.getByRole("heading", { level: 1, name: clientName })).toBeVisible({ timeout: COLD_COMPILE });

    // 4. The Tasks tab: empty until the generator runs, then one task.
    // Scoped to <main>: the sidebar has a "Tasks" link of its own.
    await page.getByRole("main").getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "Onboarding" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("button", { name: "Generate onboarding tasks" })).toBeVisible();

    await page.getByRole("button", { name: "Generate onboarding tasks" }).click();
    const taskLink = page.getByRole("link", { name: templateTitle });
    await expect(taskLink).toBeVisible();
    await expect(page.getByText("0 of 1")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Onboarding" })).toHaveAttribute("aria-valuenow", "0");

    // Generation is idempotent: a second run must not create a second task.
    await page.getByRole("button", { name: "Generate onboarding tasks" }).click();
    await expect(page.getByText("0 of 1")).toBeVisible();
    await expect(page.getByRole("link", { name: templateTitle })).toHaveCount(1);

    // 5. The task detail screen.
    await taskLink.click();
    await expect(page.getByRole("heading", { level: 1, name: templateTitle })).toBeVisible({ timeout: COLD_COMPILE });

    await page.locator('textarea[name="bodyMd"]').fill(comment);
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByText(comment)).toBeVisible();

    await page.getByRole("button", { name: "Complete Book the call" }).click();
    await expect(page.getByRole("button", { name: "Undo Book the call" })).toBeVisible();

    const assignee = page.locator('select[name="assigneeUserId"]');
    await assignee.selectOption({ index: 1 });
    await page.getByRole("form", { name: "Assignee" }).getByRole("button", { name: "Save" }).click();
    // Wait for the action to land before reloading — a reload mid-flight would
    // race the POST and re-render the page from before the assignment.
    await expect(page.getByText("Assignee saved")).toBeVisible();
    // Reloaded rather than trusting the select the browser already holds: the
    // assertion has to prove the assignment was written, not that a click stuck.
    await page.reload();
    await expect(assignee).not.toHaveValue("");

    await expect(page.getByText("Visible to the client.")).toBeVisible();
    await page.getByRole("button", { name: "Hide from client" }).click();
    await expect(page.getByText("Hidden from the client.")).toBeVisible();

    // 6. Closing the only onboarding task fills in the client's onboarded date.
    const status = page.locator('select[name="status"]');
    await status.selectOption("done");
    await page.getByRole("button", { name: "Move" }).click();
    await expect(status).toHaveValue("done");

    await page.getByRole("link", { name: clientName }).click();
    await expect(page.getByText("1 of 1")).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("progressbar", { name: "Onboarding" })).toHaveAttribute("aria-valuenow", "100");
    await expect(page.getByRole("button", { name: "Hidden" })).toBeVisible();
    await expect(page.getByText(/Onboarded \d/)).toBeVisible();
    await expect(page.getByRole("cell", { name: "Unassigned" })).toHaveCount(0);
  } finally {
    // Tasks, activity and the billing profile cascade from the client.
    await db
      .delete(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisation.id), eq(schema.clients.name, clientName)));
    await db
      .delete(schema.taskTemplates)
      .where(and(eq(schema.taskTemplates.organisationId, organisation.id), eq(schema.taskTemplates.title, templateTitle)));
    await db
      .delete(schema.packages)
      .where(and(eq(schema.packages.organisationId, organisation.id), eq(schema.packages.slug, packageSlug)));
    await db.$client.end();
  }
});
