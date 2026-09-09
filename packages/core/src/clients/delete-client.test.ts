import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "@launchos/db/test";
import { describe, expect, it } from "vitest";
import { clientDeletionReport, deleteClient, listArchivedClients, restoreClient } from "./delete-client.js";
import { archiveClient } from "./update-client.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `del-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientId: client!.id, clientName: client!.name };
}

const PERIOD = {
  currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
};

describe("clientDeletionReport", () => {
  it("lets a client with nothing filed under it go", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await fixture(db);
      const report = await clientDeletionReport(db, orgId, clientId);
      expect(report.deletable).toBe(true);
      expect(report.blockers).toEqual([]);
      expect(report.warnings).toEqual([]);
    });
  });

  /**
   * A paid invoice is the business's own accounting record. It has to survive
   * six years in the UK, and it does not belong to the client it was addressed
   * to — so this is refused rather than confirmed.
   */
  it("blocks on a paid invoice and offers archiving instead", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, clientName } = await fixture(db);
      await db.insert(schema.invoices).values({
        organisationId: orgId, clientId, number: `LF-${randomUUID().slice(0, 8)}`, status: "paid",
        dueAt: new Date("2026-09-15T00:00:00Z"), subtotalPence: 22000, totalPence: 22000,
      });

      const report = await clientDeletionReport(db, orgId, clientId);
      expect(report.deletable).toBe(false);
      expect(report.blockers.map((b) => b.kind)).toContain("paid_invoice");

      await expect(
        deleteClient(db, orgId, { clientId, confirmName: clientName, actorKind: "user", actorId: "u1" }),
      ).rejects.toThrow(/Archive the client instead/);

      // And the client is still there afterwards.
      const [still] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
      expect(still).toBeDefined();
    });
  });

  it("blocks on a live subscription, because the provider would keep charging", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, clientName } = await fixture(db);
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, amountPence: 22000,
        stripeSubscriptionId: `sub_${randomUUID()}`, ...PERIOD,
      });

      const report = await clientDeletionReport(db, orgId, clientId);
      expect(report.deletable).toBe(false);
      expect(report.blockers.map((b) => b.kind)).toContain("active_subscription");
      await expect(
        deleteClient(db, orgId, { clientId, confirmName: clientName, actorKind: "user", actorId: "u1" }),
      ).rejects.toThrow();
    });
  });

  it("warns about work without blocking it", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, clientName } = await fixture(db);
      await db.insert(schema.sites).values({
        organisationId: orgId, clientId, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk",
      });

      const report = await clientDeletionReport(db, orgId, clientId);
      expect(report.deletable).toBe(true);
      expect(report.warnings).toContainEqual({ kind: "websites", count: 1 });

      await deleteClient(db, orgId, { clientId, confirmName: clientName, actorKind: "user", actorId: "u1" });

      const [gone] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
      expect(gone).toBeUndefined();
    });
  });

  it("refuses a name that does not match, and changes nothing", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await fixture(db);
      await expect(
        deleteClient(db, orgId, { clientId, confirmName: "Something Else", actorKind: "user", actorId: "u1" }),
      ).rejects.toThrow(/exactly/);
      const [still] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
      expect(still).toBeDefined();
    });
  });

  /**
   * The audit is written before the delete, because afterwards there is no row
   * left for it to point at. Without this the only record that a client ever
   * existed disappears with the client.
   */
  it("records what was destroyed before destroying it", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, clientName } = await fixture(db);
      await deleteClient(db, orgId, { clientId, confirmName: clientName, actorKind: "user", actorId: "u1" });

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetId, clientId),
      ));
      const entry = audits.find((a) => a.targetId === clientId && a.action === "client.deleted");
      expect(entry).toBeDefined();
      expect((entry!.before as { name?: string })?.name).toBe(clientName);
    });
  });
});

describe("archive and restore", () => {
  it("lists an archived client and puts it back", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await fixture(db);
      await archiveClient(db, orgId, { clientId, actorKind: "user", actorId: "u1" });

      const archived = await listArchivedClients(db, orgId);
      expect(archived.map((c) => c.id)).toContain(clientId);

      const restored = await restoreClient(db, orgId, { clientId, actorKind: "user", actorId: "u1" });
      expect(restored.status).toBe("active");
      expect((await listArchivedClients(db, orgId)).map((c) => c.id)).not.toContain(clientId);
    });
  });
});
