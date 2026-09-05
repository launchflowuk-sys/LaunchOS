import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, like } from "drizzle-orm";
import { CLIENT, DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The client portal's Content page: it renders for the seeded portal user,
 * and a suggestion posted from it lands in the admin Content screen as a
 * draft marked as the client's. The row it creates is removed in `afterAll`.
 */
// The dev server compiles each route the first time it is requested.
const COLD_COMPILE = 120_000;

const db = createDb(DATABASE_URL);

const STAMP = Date.now();
const TEXT = `We now cover Lakeside and Bluewater with fixed fares — could we post about it? (${STAMP})`;
const LINK = "https://grayscabline.co.uk/lakeside";

let organisationId: string;
let clientId: string;

async function signInAsPortalUser(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(CLIENT.email);
  await page.getByLabel("Password").fill(CLIENT.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/portal", { timeout: COLD_COMPILE });
}

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
});

test.afterAll(async () => {
  if (!clientId) return;
  const items = await db
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.clientId, clientId), eq(schema.contentItems.body, TEXT)));
  for (const item of items) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, item.id));
    await db.delete(schema.activityEvents).where(like(schema.activityEvents.link, `/content/${item.id}%`));
    await db.delete(schema.notifications).where(like(schema.notifications.link, `/content/${item.id}%`));
    await db.delete(schema.contentItems).where(eq(schema.contentItems.id, item.id));
  }
});

test.describe("client portal content", () => {
  test("renders, takes a suggestion, and the suggestion is a draft in admin", async ({ page, browser }) => {
    test.setTimeout(420_000);

    // 1. The page, from the tab row.
    await signInAsPortalUser(page);
    await page.getByRole("navigation").getByRole("link", { name: "Content" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Content" })).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByRole("heading", { level: 2, name: "Coming up" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Published" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Suggest a post" })).toBeVisible();

    // 2. Suggest a post.
    const form = page.getByRole("form", { name: "Suggest a post" });
    await form.getByLabel("What should the post say?").fill(TEXT);
    await form.getByLabel("Link to include (optional)").fill(LINK);
    await form.getByRole("button", { name: "Send suggestion" }).click();
    await expect(page.getByText("Thanks — we have added it to your list")).toBeVisible({ timeout: COLD_COMPILE });
    // The form reset, so a second click cannot post it twice by accident.
    await expect(form.getByLabel("What should the post say?")).toHaveValue("");

    const [item] = await db
      .select()
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.clientId, clientId), eq(schema.contentItems.body, TEXT)));
    expect(item).toBeDefined();
    expect(item!.organisationId).toBe(organisationId);
    expect(item!.status).toBe("draft");
    expect(item!.source).toBe("client");
    expect(item!.channel).toBe("facebook");
    expect(item!.linkUrl).toBe(LINK);
    expect(item!.suggestedByUserId).not.toBeNull();

    // 3. The owner sees it as a draft, marked as the client's idea.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    try {
      await signIn(admin);
      await admin.goto(`/content/${item!.id}`);
      await expect(admin.getByRole("heading", { level: 1, name: item!.title ?? "" })).toBeVisible({ timeout: COLD_COMPILE });
      await expect(admin.getByText("Suggested by the client")).toBeVisible();
      await expect(admin.locator('[data-status="draft"]')).toBeVisible();
      await expect(admin.getByRole("form", { name: "Edit post" }).getByLabel("Text")).toHaveValue(TEXT);
      await expect(admin.getByRole("form", { name: "Edit post" }).getByLabel("Link")).toHaveValue(LINK);
      await expect(admin.getByText("The client", { exact: true })).toBeVisible();
    } finally {
      await adminContext.close();
    }
  });
});
