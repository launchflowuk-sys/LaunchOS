import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_BRAND_ACCENT, DEFAULT_BRAND_PRIMARY, getClientBrand, setClientBrand,
} from "./brand.js";
import { createClient } from "./create-client.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `brand-${randomUUID()}` }).returning();
  return org!;
}

function auditRows(db: Db, organisationId: string) {
  return db.select().from(schema.auditLog).where(and(
    eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "client.brand_updated"),
  ));
}

describe("client brand", () => {
  it("falls back to the LaunchFlow defaults and the client's trading name", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine Ltd", tradingName: "Grays CabLine" });

      expect(await getClientBrand(db, org.id, { clientId: client.id })).toEqual({
        primary: DEFAULT_BRAND_PRIMARY,
        accent: DEFAULT_BRAND_ACCENT,
        logoAssetId: null,
        wordmark: "Grays CabLine",
      });
    });
  });

  it("merges a partial patch, lower-cases hex, clears a field on null and audits every write", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Star Cat Grooming" });

      await setClientBrand(db, org.id, { clientId: client.id, primary: "#2B1B4A", wordmark: "Star Cat" });
      // A second call touches only the accent; the first call's fields survive.
      const row = await setClientBrand(db, org.id, { clientId: client.id, accent: "#ff8a3d" });

      expect(row.metadata.brand).toEqual({ primary: "#2b1b4a", accent: "#ff8a3d", wordmark: "Star Cat" });
      expect(await getClientBrand(db, org.id, { clientId: client.id })).toEqual({
        primary: "#2b1b4a", accent: "#ff8a3d", logoAssetId: null, wordmark: "Star Cat",
      });

      await setClientBrand(db, org.id, { clientId: client.id, wordmark: null });
      const cleared = await getClientBrand(db, org.id, { clientId: client.id });
      expect(cleared.wordmark).toBe("Star Cat Grooming");
      expect(cleared.primary).toBe("#2b1b4a");

      expect(await auditRows(db, org.id)).toHaveLength(3);
    });
  });

  it("leaves the rest of the client's metadata alone", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Lakeside Taxis" });
      await db.update(schema.clients).set({ metadata: { keepMe: "yes" } }).where(eq(schema.clients.id, client.id));

      const row = await setClientBrand(db, org.id, { clientId: client.id, primary: "#101010" });
      expect(row.metadata.keepMe).toBe("yes");
      expect(row.metadata.brand).toEqual({ primary: "#101010" });
    });
  });

  it("refuses a logo that is not one of this client's images", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const mine = await createClient(db, org.id, { name: "Mine" });
      const theirs = await createClient(db, org.id, { name: "Theirs" });
      const [asset] = await db.insert(schema.contentAssets).values({
        organisationId: org.id, clientId: theirs.id, path: `content/${org.id}/x.png`, mime: "image/png", sizeBytes: 10,
      }).returning();

      await expect(setClientBrand(db, org.id, { clientId: mine.id, logoAssetId: asset!.id }))
        .rejects.toThrow(/not one of this client's images/);
    });
  });

  it("is invisible to, and cannot be written by, another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const client = await createClient(db, orgA.id, { name: "Grays CabLine" });
      await setClientBrand(db, orgA.id, { clientId: client.id, primary: "#010203" });

      await expect(getClientBrand(db, orgB.id, { clientId: client.id })).rejects.toThrow(/not found in organisation/);
      await expect(setClientBrand(db, orgB.id, { clientId: client.id, primary: "#040506" }))
        .rejects.toThrow(/not found in organisation/);
      expect((await getClientBrand(db, orgA.id, { clientId: client.id })).primary).toBe("#010203");
      expect(await auditRows(db, orgB.id)).toHaveLength(0);
    });
  });
});
