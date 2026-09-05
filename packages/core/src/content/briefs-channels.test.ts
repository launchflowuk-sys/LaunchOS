import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { getContentBrief, upsertContentBrief } from "./briefs.js";
import { listContentChannels, setContentChannel } from "./channels.js";
import { auditRows, contentFixture } from "./test-fixtures.js";

describe("content briefs", () => {
  it("creates then replaces the brief, one row per client, audited both times", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);

      const created = await upsertContentBrief(db, orgId, {
        clientId, tone: "Friendly, local", audience: "Grays residents", services: "Airport runs", actorId: ownerId,
      });
      expect(created.tone).toBe("Friendly, local");
      expect(created.updatedByUserId).toBe(ownerId);
      expect(created.offers).toBeNull();

      const replaced = await upsertContentBrief(db, orgId, { clientId, tone: "Plain", offers: "10% off first ride", actorId: ownerId });
      expect(replaced.id).toBe(created.id);
      expect(replaced.tone).toBe("Plain");
      expect(replaced.offers).toBe("10% off first ride");
      // The form sends the whole brief: an omitted field is cleared, not kept.
      expect(replaced.audience).toBeNull();

      expect((await getContentBrief(db, orgId, { clientId }))?.id).toBe(created.id);
      expect(await auditRows(db, orgId, "content_brief.created")).toHaveLength(1);
      expect(await auditRows(db, orgId, "content_brief.updated")).toHaveLength(1);
    });
  });

  it("is invisible to, and cannot be written by, another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      await upsertContentBrief(db, orgId, { clientId, tone: "Ours" });

      expect(await getContentBrief(db, other.orgId, { clientId })).toBeUndefined();
      await expect(upsertContentBrief(db, other.orgId, { clientId, tone: "Theirs" })).rejects.toThrow(/not found in organisation/);
    });
  });
});

describe("content channels", () => {
  it("connects a channel, replaces it on a second call and lists enabled ones", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);

      const page = await setContentChannel(db, orgId, { clientId, channel: "facebook", externalId: "123", displayName: "Grays CabLine" });
      await setContentChannel(db, orgId, { clientId, channel: "instagram", externalId: "ig-1", enabled: false });
      const reconnected = await setContentChannel(db, orgId, { clientId, channel: "facebook", externalId: "456" });

      expect(reconnected.id).toBe(page.id);
      expect(reconnected.externalId).toBe("456");
      expect(reconnected.displayName).toBeNull();

      const all = await listContentChannels(db, orgId, { clientId });
      expect(all.map((c) => c.channel)).toEqual(["facebook", "instagram"]);
      const enabled = await listContentChannels(db, orgId, { clientId, enabledOnly: true });
      expect(enabled.map((c) => c.channel)).toEqual(["facebook"]);

      expect(await auditRows(db, orgId, "content_channel.created")).toHaveLength(2);
      expect(await auditRows(db, orgId, "content_channel.updated")).toHaveLength(1);
    });
  });

  it("is invisible to another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      await setContentChannel(db, orgId, { clientId, channel: "blog", externalId: "site-1" });

      expect(await listContentChannels(db, other.orgId, { clientId })).toEqual([]);
      await expect(setContentChannel(db, other.orgId, { clientId, channel: "blog", externalId: "x" })).rejects.toThrow(/not found in organisation/);
    });
  });
});
