import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attributionOf } from "../leads/attribution.js";
import { captureLeadFromDraft } from "./capture.js";
import { LATEST_TOUCH_PREFIX, latestAttributionOf } from "./lead-attribution.js";
import { recordLatestTouch, safeSource, startBriefSession } from "./sessions.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const PAID_VISIT = {
  utm_source: "facebook",
  utm_medium: "paid_social",
  utm_campaign: "launchflow_growth",
  utm_content: "creative_a",
  fbclid: "IwAR-test",
  gclid: "Cj0-test",
  entry_route: "/start",
};

describe("safeSource", () => {
  it("keeps the click identifiers an ad platform sends, not only the UTM tags", () => {
    const kept = safeSource({
      utm_id: "23858",
      gclid: "Cj0KCQ",
      fbclid: "IwAR1",
      gbraid: "0AAAAA",
      wbraid: "Cj8KCQ",
      msclkid: "abc123",
      ttclid: "tt-9",
      referrer: "grow.launchflow.co.uk",
    });
    expect(kept).toEqual({
      utm_id: "23858",
      gclid: "Cj0KCQ",
      fbclid: "IwAR1",
      gbraid: "0AAAAA",
      wbraid: "Cj8KCQ",
      msclkid: "abc123",
      ttclid: "tt-9",
      referrer: "grow.launchflow.co.uk",
    });
  });

  it("keeps latest-touch keys, and still refuses anything else", () => {
    expect(safeSource({ [`${LATEST_TOUCH_PREFIX}utm_source`]: "google", email: "sam@example.com" })).toEqual({
      [`${LATEST_TOUCH_PREFIX}utm_source`]: "google",
    });
  });

  it("truncates a click id the same way it truncates a UTM tag", () => {
    expect(safeSource({ gclid: "x".repeat(500) }).gclid).toHaveLength(200);
  });
});

describe("recordLatestTouch", () => {
  it("records a later campaign without disturbing the one that brought them", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: { utm_source: "google", utm_campaign: "spring" } });

      await recordLatestTouch(db, org.id, session.id, { utm_source: "facebook", utm_campaign: "autumn" });

      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.source.utm_source).toBe("google");
      expect(row!.source.utm_campaign).toBe("spring");
      expect(row!.source[`${LATEST_TOUCH_PREFIX}utm_source`]).toBe("facebook");
      expect(row!.source[`${LATEST_TOUCH_PREFIX}utm_campaign`]).toBe("autumn");
    });
  });

  it("overwrites an older latest touch, because latest means latest", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: { utm_source: "google" } });

      await recordLatestTouch(db, org.id, session.id, { utm_source: "facebook" });
      await recordLatestTouch(db, org.id, session.id, { utm_source: "bing" });

      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.source[`${LATEST_TOUCH_PREFIX}utm_source`]).toBe("bing");
      expect(row!.source.utm_source).toBe("google");
    });
  });

  it("writes nothing at all for a visit carrying no campaign", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: { utm_source: "google" } });

      await recordLatestTouch(db, org.id, session.id, { entry_route: "/start" });

      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      // An entry route on its own is not a campaign; recording it would make
      // every returning organic visitor look like a second touch.
      expect(row!.source[`${LATEST_TOUCH_PREFIX}entry_route`]).toBeUndefined();
    });
  });
});

describe("captureLeadFromDraft — attribution", () => {
  it("puts the campaign that brought them on the lead it creates", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: PAID_VISIT });

      const { leadId, created } = await captureLeadFromDraft(db, org.id, session.id, {
        name: "Sam",
        email: "sam@example.com",
      });

      expect(created).toBe(true);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId!));
      expect(attributionOf(lead!.metadata)).toEqual({
        utmSource: "facebook",
        utmMedium: "paid_social",
        utmCampaign: "launchflow_growth",
        utmContent: "creative_a",
        fbclid: "IwAR-test",
        gclid: "Cj0-test",
        landingPath: "/start",
      });
    });
  });

  it("stores no attribution at all for a direct visit", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: { entry_route: "/start" } });

      const { leadId } = await captureLeadFromDraft(db, org.id, session.id, { phone: "07700900123" });

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId!));
      expect(attributionOf(lead!.metadata)).toEqual({ landingPath: "/start" });
      expect(latestAttributionOf(lead!.metadata)).toEqual({});
    });
  });

  it("keeps the original campaign when a later one is recorded, and stores the later one beside it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: { utm_source: "google", utm_campaign: "spring" } });
      await captureLeadFromDraft(db, org.id, session.id, { email: "sam@example.com" });

      await recordLatestTouch(db, org.id, session.id, { utm_source: "facebook", utm_campaign: "autumn" });
      const { leadId, created } = await captureLeadFromDraft(db, org.id, session.id, { name: "Sam" });

      expect(created).toBe(false);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId!));
      expect(attributionOf(lead!.metadata).utmSource).toBe("google");
      expect(attributionOf(lead!.metadata).utmCampaign).toBe("spring");
      expect(latestAttributionOf(lead!.metadata)).toEqual({ utmSource: "facebook", utmCampaign: "autumn" });
    });
  });

  it("does not lose the attribution already on a lead when later answers arrive", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, { source: PAID_VISIT });
      await captureLeadFromDraft(db, org.id, session.id, { email: "sam@example.com" });

      const { leadId } = await captureLeadFromDraft(db, org.id, session.id, { name: "Sam", business: "Sam Ltd" });

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId!));
      expect(lead!.business).toBe("Sam Ltd");
      expect(attributionOf(lead!.metadata).utmCampaign).toBe("launchflow_growth");
      expect(attributionOf(lead!.metadata).fbclid).toBe("IwAR-test");
    });
  });
});
