import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { eq, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The owner adds a mock Hetzner connection on Infrastructure, syncs it, sees
 * the mock servers on /servers, and reboots one through the named-confirm
 * dialog. `mock_`-prefixed tokens select the mock Hetzner client
 * (`@launchos/integrations`) — never a real account, never a real server.
 *
 * Cleanup removes the connection this test created (servers cascade with it),
 * the `supplier_costs` rows the sync wrote for it, and the audit rows the
 * connection and the reboot left behind — `audit_log` has no cascade from
 * either table, so a leftover `infra.server.reboot` row survives the
 * connection delete and can collide with other tests that query it
 * unscoped. The run leaves nothing behind in whatever database it points at.
 */
const COLD_COMPILE = 120_000;
const db = createDb(DATABASE_URL);
const STAMP = Date.now();
const LABEL = `E2E Hetzner ${STAMP}`;

let connectionId: string | null = null;

async function cleanUp(): Promise<void> {
  if (!connectionId) return;
  const servers = await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.connectionId, connectionId));
  const serverIds = servers.map((s) => s.id);
  await db.delete(schema.auditLog).where(
    or(
      eq(schema.auditLog.targetId, connectionId),
      serverIds.length > 0 ? inArray(schema.auditLog.targetId, serverIds) : eq(schema.auditLog.targetId, connectionId),
    ),
  );
  await db.delete(schema.supplierCosts).where(like(schema.supplierCosts.externalId, `${connectionId}:%`));
  await db.delete(schema.infraConnections).where(eq(schema.infraConnections.id, connectionId));
  connectionId = null;
}

test.afterEach(async () => {
  await cleanUp();
});

test.afterAll(async () => {
  await db.$client.end();
});

test("owner adds a mock Hetzner connection, syncs, sees servers, reboots one", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto("/settings/infrastructure");
  await expect(page.getByRole("heading", { name: "Infrastructure" })).toBeVisible({ timeout: COLD_COMPILE });

  await page.getByLabel("Provider").selectOption("hetzner_cloud");
  await page.getByLabel("Label").fill(LABEL);
  await page.getByLabel("Token").fill("mock_e2e");
  await page.getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByText(`${LABEL} saved.`)).toBeVisible({ timeout: COLD_COMPILE });

  const [connection] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.label, LABEL));
  expect(connection).toBeDefined();
  connectionId = connection!.id;

  const connectionRow = page.getByRole("row", { name: new RegExp(LABEL) });
  await expect(connectionRow).toBeVisible();

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(connectionRow.getByText("Never")).toHaveCount(0, { timeout: COLD_COMPILE });

  await page.goto("/servers");
  await expect(page.getByText("mock-pizza").first()).toBeVisible({ timeout: COLD_COMPILE });

  // The servers table is `<details>` rows, not a real HTML table, so no
  // `role="row"` exists to select on — scope by the server's name instead.
  const row = page.locator("details").filter({ hasText: "mock-pizza" }).first();
  await row.getByRole("button", { name: "Server actions" }).click();
  await page.getByRole("menuitem", { name: "Reboot" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Type mock-pizza to confirm/).fill("mock-pizza");
  await dialog.getByRole("button", { name: "Reboot" }).click();

  await expect(row.getByText(/Rebooting/).first()).toBeVisible({ timeout: COLD_COMPILE });
});
