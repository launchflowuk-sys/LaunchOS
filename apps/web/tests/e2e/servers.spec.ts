import { createDb, schema } from "@launchos/db";
import { expect, test } from "@playwright/test";
import { eq, inArray, like, or } from "drizzle-orm";
import { DATABASE_URL } from "./seed-credentials";
import { signIn } from "./sign-in";

/**
 * The owner adds a mock Hetzner connection on Infrastructure, sees its
 * server on /servers, expands the row, and reboots it through the
 * named-confirm dialog. `mock_`-prefixed tokens select the mock Hetzner
 * client (`@launchos/integrations`) — never a real account, never a real
 * server.
 *
 * The server row is written straight to the database rather than by clicking
 * "Sync now": that button syncs every connection in the organisation, and the
 * dev database holds the real Hetzner and Coolify connections too. The sync
 * itself is covered against the mock in `packages/core` (sync.test.ts).
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

test("owner adds a mock Hetzner connection, sees its server, expands it, reboots it", async ({ page }) => {
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

  await expect(page.getByRole("row", { name: new RegExp(LABEL) })).toBeVisible();

  const [server] = await db
    .insert(schema.servers)
    .values({
      organisationId: connection!.organisationId,
      connectionId: connection!.id,
      hetznerId: 2,
      name: "mock-pizza",
      serverType: "cx23",
      location: "nbg1",
      ipv4: "10.9.0.2",
      status: "running",
      hetznerCreatedAt: new Date("2026-09-05T00:00:00Z"),
    })
    .returning();

  await page.goto("/servers");
  const row = page.locator('[data-server-row="mock-pizza"]');
  await expect(row).toBeVisible({ timeout: COLD_COMPILE });

  // The expand toggle is its own button; the apps list lives in the body.
  await row.getByRole("button", { name: "Show details for mock-pizza" }).click();
  await expect(row.getByText("No Coolify linked to this server.")).toBeVisible();

  await row.getByRole("button", { name: "Server actions" }).click();
  await page.getByRole("menuitem", { name: "Reboot" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Type mock-pizza to confirm/).fill("mock-pizza");
  await dialog.getByRole("button", { name: "Reboot" }).click();

  // The mock settles instantly, so the next page load clears the pending
  // action — the proof is the toast and the audit row, not a lingering badge.
  await expect(page.getByText("Sent to Hetzner.")).toBeVisible({ timeout: COLD_COMPILE });
  await expect
    .poll(async () => (await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, server!.id))).map((a) => a.action))
    .toContain("infra.server.reboot");
});
