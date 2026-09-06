import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { mergeClients } from "../clients/merge-clients.js";
import { setEnqueue } from "../events/emit.js";
import { SecretsKeyError } from "../secrets/encryption.js";
import { createSite } from "../sites/create-site.js";
import { accessLog } from "./access-log.js";
import { createAccessEntry, deleteAccessEntry, listAccessEntries, updateAccessEntry } from "./access-entries.js";
import { revealAccessSecret } from "./reveal-access-secret.js";

const ENV = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const PASSWORD = "Hetzner-r00t-Pa55word!";

setEnqueue(async () => {});

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
  const [owner] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: "Shoji", email: `owner-${randomUUID()}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner", status: "active" });
  const client = await createClient(db, org!.id, { name: "Acme" });
  const site = await createSite(db, org!.id, { clientId: client.id, name: "acme.test", primaryUrl: "https://acme.test" });
  return { organisationId: org!.id, ownerId: owner!.id, client, site };
}

/** Pushes the audit rows for `targetIds` (optionally one action) `seconds` into the past. */
async function backdate(db: Db, targetIds: string[], seconds: number, action?: string): Promise<void> {
  await db
    .update(schema.auditLog)
    .set({ createdAt: sql`${schema.auditLog.createdAt} - make_interval(secs => ${seconds})` })
    .where(and(inArray(schema.auditLog.targetId, targetIds), action ? eq(schema.auditLog.action, action) : undefined));
}

const SERVER = {
  kind: "server" as const,
  label: "Hetzner CX22",
  host: "88.198.0.1",
  port: 22,
  username: "root",
  notes: "Coolify lives here",
};

describe("client access vault", () => {
  it("stores the secret as ciphertext, lists without it, and audits without it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client, site } = await fixture(db);

      const created = await createAccessEntry(
        db,
        organisationId,
        { clientId: client.id, siteId: site.id, ...SERVER, secret: PASSWORD, actorId: ownerId },
        ENV,
      );
      expect(created).toMatchObject({ clientId: client.id, siteId: site.id, kind: "server", label: "Hetzner CX22", hasSecret: true });
      expect(JSON.stringify(created)).not.toContain(PASSWORD);

      const [row] = await db.select().from(schema.clientAccessEntries).where(eq(schema.clientAccessEntries.id, created.id));
      expect(row!.secretCiphertext!.startsWith("v1.")).toBe(true);
      expect(row!.secretCiphertext).not.toContain(PASSWORD);
      expect(row!.organisationId).toBe(organisationId);
      expect(row!.createdBy).toBe(ownerId);

      const listed = await listAccessEntries(db, organisationId, client.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: created.id, hasSecret: true, siteName: "acme.test", lastViewedAt: null, lastViewedByName: null });
      expect(JSON.stringify(listed)).not.toContain(PASSWORD);
      expect(JSON.stringify(listed)).not.toContain("v1.");

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "client_access.created"), eq(schema.auditLog.targetId, created.id)));
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe(ownerId);
      expect(audit!.targetType).toBe("client_access_entry");
      expect(audit!.after).toMatchObject({ clientId: client.id, label: "Hetzner CX22", username: "root", hasSecret: true });
      expect(JSON.stringify(audit!.after)).not.toContain(PASSWORD);
      expect(JSON.stringify(audit!.after)).not.toContain("v1.");
    });
  });

  it("refuses to store a secret when the encryption key is unset, but takes an entry without one", async () => {
    await withTestDb(async (db) => {
      const { organisationId, client } = await fixture(db);

      await expect(createAccessEntry(db, organisationId, { clientId: client.id, ...SERVER, secret: PASSWORD }, {})).rejects.toThrow(
        SecretsKeyError,
      );
      expect(await listAccessEntries(db, organisationId, client.id)).toHaveLength(0);

      const plain = await createAccessEntry(db, organisationId, { clientId: client.id, ...SERVER }, {});
      expect(plain.hasSecret).toBe(false);

      await expect(updateAccessEntry(db, organisationId, { entryId: plain.id, secret: PASSWORD }, {})).rejects.toThrow(SecretsKeyError);
      expect((await listAccessEntries(db, organisationId, client.id))[0]!.hasSecret).toBe(false);
    });
  });

  it("updates fields, replaces or clears the secret, and leaves it alone when not mentioned", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client } = await fixture(db);
      const entry = await createAccessEntry(db, organisationId, { clientId: client.id, ...SERVER, secret: PASSWORD }, ENV);

      const renamed = await updateAccessEntry(db, organisationId, { entryId: entry.id, username: "deploy", port: 2222, actorId: ownerId }, ENV);
      expect(renamed).toMatchObject({ username: "deploy", port: 2222, hasSecret: true });
      expect((await revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV)).secret).toBe(PASSWORD);

      await updateAccessEntry(db, organisationId, { entryId: entry.id, secret: "rotated", actorId: ownerId }, ENV);
      expect((await revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV)).secret).toBe("rotated");

      const cleared = await updateAccessEntry(db, organisationId, { entryId: entry.id, secret: null, actorId: ownerId }, ENV);
      expect(cleared.hasSecret).toBe(false);
      await expect(revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV)).rejects.toThrow(/no password/i);

      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "client_access.updated"), eq(schema.auditLog.targetId, entry.id)))
        .orderBy(schema.auditLog.createdAt);
      expect(audits).toHaveLength(3);
      expect(audits[0]!.before).toMatchObject({ username: "root", port: 22 });
      expect(audits[0]!.after).toMatchObject({ username: "deploy", port: 2222 });
      expect(audits[2]!.before).toMatchObject({ hasSecret: true });
      expect(audits[2]!.after).toMatchObject({ hasSecret: false });
      expect(JSON.stringify(audits)).not.toContain(PASSWORD);
      expect(JSON.stringify(audits)).not.toContain("rotated");
    });
  });

  it("reveals the plaintext once, records who looked and when, and stamps the row", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client } = await fixture(db);
      const entry = await createAccessEntry(db, organisationId, { clientId: client.id, ...SERVER, secret: PASSWORD }, ENV);

      const revealed = await revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV);
      expect(revealed.secret).toBe(PASSWORD);
      expect(revealed.lastViewedAt).toBeInstanceOf(Date);

      const [listed] = await listAccessEntries(db, organisationId, client.id);
      expect(listed!.lastViewedBy).toBe(ownerId);
      expect(listed!.lastViewedByName).toBe("Shoji");
      expect(listed!.lastViewedAt?.getTime()).toBe(revealed.lastViewedAt.getTime());

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "client_access.revealed"), eq(schema.auditLog.targetId, entry.id)));
      expect(audit).toBeDefined();
      expect(audit!.actorKind).toBe("user");
      expect(audit!.actorId).toBe(ownerId);
      expect(audit!.after).toMatchObject({ clientId: client.id, label: "Hetzner CX22" });
      expect(JSON.stringify(audit!.after)).not.toContain(PASSWORD);
    });
  });

  it("keeps every organisation to its own entries, clients and sites", async () => {
    await withTestDb(async (db) => {
      const a = await fixture(db);
      const b = await fixture(db);

      await expect(createAccessEntry(db, a.organisationId, { clientId: b.client.id, ...SERVER }, ENV)).rejects.toThrow(/not found in organisation/);
      await expect(
        createAccessEntry(db, a.organisationId, { clientId: a.client.id, siteId: b.site.id, ...SERVER }, ENV),
      ).rejects.toThrow(/not found in organisation/);

      const other = await createClient(db, a.organisationId, { name: "Other" });
      await expect(
        createAccessEntry(db, a.organisationId, { clientId: other.id, siteId: a.site.id, ...SERVER }, ENV),
      ).rejects.toThrow(/belongs to another client/);

      const entry = await createAccessEntry(db, b.organisationId, { clientId: b.client.id, ...SERVER, secret: PASSWORD }, ENV);
      await expect(updateAccessEntry(db, a.organisationId, { entryId: entry.id, label: "x" }, ENV)).rejects.toThrow(/not found/);
      await expect(revealAccessSecret(db, a.organisationId, { entryId: entry.id, actorId: a.ownerId }, ENV)).rejects.toThrow(/not found/);
      await expect(deleteAccessEntry(db, a.organisationId, { entryId: entry.id })).rejects.toThrow(/not found/);
      expect(await listAccessEntries(db, a.organisationId, b.client.id)).toHaveLength(0);
      expect(await listAccessEntries(db, b.organisationId, b.client.id)).toHaveLength(1);
    });
  });

  it("deletes an entry and keeps its trail, and the access log reads it all back newest first", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client } = await fixture(db);
      const entry = await createAccessEntry(db, organisationId, { clientId: client.id, ...SERVER, secret: PASSWORD, actorId: ownerId }, ENV);
      const dashboard = await createAccessEntry(
        db,
        organisationId,
        { clientId: client.id, kind: "dashboard", label: "WP admin", url: "https://acme.test/wp-admin", username: "acme", actorId: ownerId },
        ENV,
      );
      // Rows written in one test transaction share `now()`, so the earlier
      // steps are backdated to give the newest-first order something to order by.
      await backdate(db, [entry.id, dashboard.id], 120);
      await revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV);
      await backdate(db, [entry.id], 60, "client_access.revealed");
      await deleteAccessEntry(db, organisationId, { entryId: entry.id, actorId: ownerId });

      expect((await listAccessEntries(db, organisationId, client.id)).map((row) => row.id)).toEqual([dashboard.id]);

      const log = await accessLog(db, organisationId, client.id);
      expect(log.map((row) => row.action)).toEqual([
        "client_access.deleted",
        "client_access.revealed",
        "client_access.created",
        "client_access.created",
      ]);
      expect(log[0]).toMatchObject({ entryId: entry.id, label: "Hetzner CX22", actorId: ownerId, actorName: "Shoji" });
      // The two creates share an instant, so their order between themselves is not asserted.
      expect(log.slice(2).map((row) => row.label).sort()).toEqual(["Hetzner CX22", "WP admin"]);
      expect(log.find((row) => row.entryId === dashboard.id)).toMatchObject({ action: "client_access.created", label: "WP admin" });
      expect(JSON.stringify(log)).not.toContain(PASSWORD);

      // Another client's trail is not in this one.
      const other = await createClient(db, organisationId, { name: "Other" });
      await createAccessEntry(db, organisationId, { clientId: other.id, ...SERVER, label: "Not yours" }, ENV);
      expect((await accessLog(db, organisationId, client.id)).some((row) => row.label === "Not yours")).toBe(false);
    });
  });

  it("moves the entries with a client merge", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerId, client: keep } = await fixture(db);
      const duplicate = await createClient(db, organisationId, { name: "Acme (dup)" });
      const entry = await createAccessEntry(db, organisationId, { clientId: duplicate.id, ...SERVER, secret: PASSWORD }, ENV);

      const result = await mergeClients(db, organisationId, { keepId: keep.id, mergeId: duplicate.id, actorId: ownerId });
      expect(result.moved["client_access_entries"]).toBe(1);

      const moved = await listAccessEntries(db, organisationId, keep.id);
      expect(moved.map((row) => row.id)).toEqual([entry.id]);
      expect(await listAccessEntries(db, organisationId, duplicate.id)).toHaveLength(0);
      // The ciphertext travelled untouched.
      expect((await revealAccessSecret(db, organisationId, { entryId: entry.id, actorId: ownerId }, ENV)).secret).toBe(PASSWORD);

      const [latest] = await db
        .select()
        .from(schema.clientAccessEntries)
        .where(eq(schema.clientAccessEntries.id, entry.id))
        .orderBy(desc(schema.clientAccessEntries.updatedAt));
      expect(latest!.clientId).toBe(keep.id);
    });
  });
});
