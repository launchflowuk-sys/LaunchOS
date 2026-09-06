import { createClient, createSite } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, like, sql } from "drizzle-orm";
import { DATABASE_URL, OWNER } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The client access vault: the owner adds a server with a password, the list
 * shows everything but the password, Reveal shows it for a while and puts
 * the reveal on record (row stamp + audit + the tab's own log), Edit keeps
 * the stored password when the field is left blank, Delete asks first and
 * keeps the trail. Then the small things: the website page's link into the
 * tab, keyboard reach, and a 390px viewport that does not scroll sideways.
 *
 * The dev server must carry `SECRETS_ENCRYPTION_KEY`, or saving a password
 * is refused with the sentence the form shows — the first test fails on that
 * sentence rather than a timeout.
 *
 * `afterAll` deletes the client (entries cascade), the audit rows the vault
 * wrote for it, and the timeline rows the client's creation left behind.
 */
const COLD_COMPILE = 120_000;
const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const CLIENT_NAME = `E2E Access ${STAMP}`;
const LABEL = `Hetzner CX22 ${STAMP}`;
const SECRET = `Pa55-${STAMP}-r00t!`;
const HOST = "88.198.146.183";
const SHOT_DIR = "../../.superpowers";

let organisationId: string;
let clientId: string;
let siteId: string;
let ownerName: string;

test.beforeAll(async () => {
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");
  organisationId = organisation.id;
  const [owner] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.email, OWNER.email));
  if (!owner) throw new Error(`seed owner ${OWNER.email} not found — run \`pnpm db:seed\` first`);
  ownerName = owner.name;

  const client = await createClient(db, organisationId, { name: CLIENT_NAME, actorKind: "system" });
  clientId = client.id;
  const site = await createSite(db, organisationId, {
    clientId, name: `acme-${STAMP}.example`, primaryUrl: `https://acme-${STAMP}.example`, actorKind: "system",
  });
  siteId = site.id;
});

test.afterAll(async () => {
  if (!clientId) return;
  await db.delete(schema.auditLog).where(
    and(eq(schema.auditLog.targetType, "client_access_entry"), sql`coalesce(${schema.auditLog.after} ->> 'clientId', ${schema.auditLog.before} ->> 'clientId') = ${clientId}`),
  );
  await db.delete(schema.clients).where(eq(schema.clients.id, clientId));
  await db.delete(schema.auditLog).where(eq(schema.auditLog.targetId, clientId));
  await db.delete(schema.activityEvents).where(like(schema.activityEvents.title, `%${STAMP}%`));
  await db.$client.end();
});

async function openAccessTab(page: Page): Promise<void> {
  await page.goto(`/clients/${clientId}/access`);
  await expect(page.getByRole("heading", { name: CLIENT_NAME })).toBeVisible({ timeout: COLD_COMPILE });
}

test("the owner adds a server with a password, reveals it on record, edits it and deletes it", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await openAccessTab(page);

  await expect(page.getByText("Encrypted at rest with the server's key. Every reveal is recorded", { exact: false })).toBeVisible();
  await expect(page.getByText("No access recorded yet")).toBeVisible();

  // Add: the form in a dialog. The password field is a password input.
  await page.getByRole("button", { name: "Add access" }).click();
  const dialog = page.getByRole("dialog", { name: "Add access" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Kind").selectOption("server");
  await dialog.getByLabel("Label", { exact: true }).fill(LABEL);
  await dialog.getByLabel("Host or IP").fill(HOST);
  await dialog.getByLabel("Port").fill("22");
  await dialog.getByLabel("Username").fill("root");
  const secretField = dialog.getByLabel("Password or key");
  await expect(secretField).toHaveAttribute("type", "password");
  await secretField.fill(SECRET);
  await dialog.getByLabel("Website").selectOption(siteId);
  await dialog.getByLabel("Notes").fill("Coolify box. Port 22.");
  await dialog.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Access added")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(dialog).toBeHidden();

  // Listed under Servers with everything but the password.
  await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
  await expect(page.getByText(LABEL).first()).toBeVisible();
  await expect(page.getByText(`${HOST}:22`).first()).toBeVisible();
  await expect(page.getByText("Never").first()).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);

  const [stored] = await db.select().from(schema.clientAccessEntries).where(eq(schema.clientAccessEntries.clientId, clientId));
  expect(stored).toBeDefined();
  expect(stored!.secretCiphertext!.startsWith("v1.")).toBe(true);
  expect(stored!.secretCiphertext).not.toContain(SECRET);
  expect(stored!.siteId).toBe(siteId);
  expect(stored!.lastViewedAt).toBeNull();
  const ciphertextBefore = stored!.secretCiphertext;

  await page.screenshot({ path: `${SHOT_DIR}/x5-access-desktop.png`, fullPage: true });

  // Reveal: the plaintext appears with a countdown, Hide takes it away, and the reveal is on record.
  await page.getByRole("button", { name: "Reveal" }).click();
  const revealed = page.getByTestId("revealed-secret");
  await expect(revealed).toBeVisible({ timeout: COLD_COMPILE });
  await expect(revealed).toHaveText(SECRET);
  await expect(page.getByText(/hides in \d+s/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy password" })).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(revealed).toHaveCount(0);

  const [reveal] = await db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "client_access.revealed"), eq(schema.auditLog.targetId, stored!.id)));
  expect(reveal).toBeDefined();
  expect(reveal!.actorKind).toBe("user");
  expect(reveal!.actorId).toBeTruthy();
  expect(JSON.stringify(reveal!.after)).not.toContain(SECRET);
  const [stamped] = await db.select().from(schema.clientAccessEntries).where(eq(schema.clientAccessEntries.id, stored!.id));
  expect(stamped!.lastViewedBy).toBe(reveal!.actorId);
  expect(stamped!.lastViewedAt).not.toBeNull();

  // The row says who looked, and the log lists the reveal and the addition.
  await page.reload();
  await expect(page.getByRole("heading", { name: CLIENT_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText(`${ownerName}, `, { exact: false }).first()).toBeVisible();
  const log = page.locator("section", { has: page.getByRole("heading", { name: "Access log" }) });
  await expect(log.getByText("Revealed").first()).toBeVisible();
  await expect(log.getByText("Added").first()).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);

  // Edit: a blank password field keeps the stored one; the username changes.
  await page.getByRole("button", { name: `Edit ${LABEL}` }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${LABEL}` });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("Username")).toHaveValue("root");
  await expect(edit.getByLabel("Password or key")).toHaveValue("");
  await expect(edit.getByText("Leave blank to keep the stored password")).toBeVisible();
  await edit.getByLabel("Username").fill("deploy");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Access updated")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByText("deploy").first()).toBeVisible();
  const [edited] = await db.select().from(schema.clientAccessEntries).where(eq(schema.clientAccessEntries.id, stored!.id));
  expect(edited!.username).toBe("deploy");
  expect(edited!.secretCiphertext).toBe(ciphertextBefore);

  // Delete: asks first, then the row goes and the log says so.
  await page.getByRole("button", { name: `Delete ${LABEL}` }).click();
  const confirm = page.getByRole("dialog", { name: `Delete ${LABEL}?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Access deleted")).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: "Servers" })).toHaveCount(0);
  await expect(page.getByText("No access recorded yet")).toBeVisible();
  await expect(page.getByText("Deleted").first()).toBeVisible();
  expect(await db.select().from(schema.clientAccessEntries).where(eq(schema.clientAccessEntries.clientId, clientId))).toHaveLength(0);
  // The trail survives the row.
  const trail = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetType, "client_access_entry"), eq(schema.auditLog.targetId, stored!.id)));
  expect(trail.map((row) => row.action).sort()).toEqual(
    ["client_access.created", "client_access.deleted", "client_access.revealed", "client_access.updated"],
  );
});

test("the website page links into the tab, the dialog is reachable by keyboard, and 390px does not scroll sideways", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto(`/websites/${siteId}`);
  await expect(page.getByRole("heading", { name: `acme-${STAMP}.example` })).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("link", { name: "Access details" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/access$`), { timeout: COLD_COMPILE });
  await expect(page.getByRole("heading", { name: CLIENT_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("link", { name: "Access", exact: true })).toHaveAttribute("aria-current", "page");

  // Keyboard: focus the header action, open it with Enter, close it with Escape.
  await page.getByRole("button", { name: "Add access" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add access" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Kind")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // 390px: one entry with a long URL and long notes; nothing may widen the page.
  await page.getByRole("button", { name: "Add access" }).click();
  await dialog.getByLabel("Kind").selectOption("dashboard");
  await dialog.getByLabel("Label", { exact: true }).fill(`WP admin ${STAMP}`);
  await dialog.getByLabel("URL").fill(`https://acme-${STAMP}.example/wp-admin/edit.php?post_type=page&orderby=title&order=asc`);
  await dialog.getByLabel("Username").fill("averyverylongusernamethatwouldoverflow@acme.example");
  await dialog.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Access added")).toBeVisible({ timeout: COLD_COMPILE });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: CLIENT_NAME })).toBeVisible({ timeout: COLD_COMPILE });
  // `DataList` keeps the table tree in the DOM under `md`, hidden; only the card copy is visible here.
  await expect(page.getByText(`WP admin ${STAMP}`).filter({ visible: true }).first()).toBeVisible();
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  await page.screenshot({ path: `${SHOT_DIR}/x5-access-390.png`, fullPage: true });
});
