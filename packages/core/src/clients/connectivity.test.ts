import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clientConnectivity, type ConnectivityCheck, type SocialReality } from "./connectivity.js";

const PAGE = "1348180978370412";

async function fixture(db: Db, includes: Partial<{ socialPostsPerMonth: number; gbpUpdatesPerMonth: number; ads: boolean }>) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `cx-${randomUUID()}` }).returning();
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: org!.id,
    name: "Standard",
    slug: `standard-${randomUUID()}`,
    monthlyPricePence: 11_000,
    includes: {
      website: true, seo: true, ads: includes.ads ?? false,
      socialPostsPerMonth: includes.socialPostsPerMonth ?? 0,
      blogPostsPerMonth: 0,
      gbpUpdatesPerMonth: includes.gbpUpdatesPerMonth ?? 0,
    },
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "Thameside Garage", slug: `tg-${randomUUID()}`, packageId: pkg!.id,
  }).returning();
  return { organisationId: org!.id, clientId: client!.id, packageId: pkg!.id };
}

const byKey = (checks: readonly ConnectivityCheck[], key: string): ConnectivityCheck =>
  checks.find((c) => c.key === key)!;

describe("clientConnectivity", () => {
  /**
   * The rule that makes the panel mean anything: a check nothing depends on
   * is not a gap. A Presence client does not post, so it is not "missing
   * Instagram" — and if it were counted, a perfectly set-up client would show
   * failures for ever and Shoji would stop reading the panel.
   */
  it("does not count social or ads against a plan that has neither", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, {});
      const state = await clientConnectivity(db, f.organisationId, f.clientId);

      expect(byKey(state.checks, "social").state).toBe("not_applicable");
      expect(byKey(state.checks, "gbp").state).toBe("not_applicable");
      expect(byKey(state.checks, "ads").state).toBe("not_applicable");
      // Not applicable is in neither the numerator nor the denominator.
      expect(state.total).toBe(state.checks.filter((c) => c.state !== "not_applicable").length);
    });
  });

  /**
   * The distinction the whole panel turns on. A Page recorded but unreachable
   * is **Shoji's** job — assign it to the system user — while a Page with no
   * id at all is the client's tap. Get this backwards and he rings a plumber
   * about something only he can fix.
   */
  it("blames the right person for a Page that is recorded but unreachable", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { socialPostsPerMonth: 8 });
      await db.insert(schema.contentChannels).values({
        organisationId: f.organisationId, clientId: f.clientId, channel: "facebook", externalId: PAGE, displayName: "Page",
      });

      const reality: SocialReality = { reachablePageIds: [], instagramByPageId: {} };
      const state = await clientConnectivity(db, f.organisationId, f.clientId, reality);
      const page = byKey(state.checks, "fb_page");

      expect(page.state).toBe("missing");
      expect(page.owner).toBe("owner");
      expect(page.next).toMatch(/Add Assets/);
    });
  });

  it("asks the client when there is no Page id at all", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { socialPostsPerMonth: 8 });
      const state = await clientConnectivity(db, f.organisationId, f.clientId, { reachablePageIds: [PAGE], instagramByPageId: {} });
      const page = byKey(state.checks, "fb_page");

      expect(page.state).toBe("missing");
      expect(page.owner).toBe("client");
      // The one-tap route, not the eight-step Business Suite walk they cannot do.
      expect(page.next).toMatch(/Request access/);
    });
  });

  /**
   * Our own token failing must never read as the client not having done
   * something. Telling Shoji to chase somebody because Graph timed out is the
   * one wrong answer this panel cannot give.
   */
  it("reports a Meta failure as blocked and ours, not as the client's fault", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { socialPostsPerMonth: 8 });
      await db.insert(schema.contentChannels).values({
        organisationId: f.organisationId, clientId: f.clientId, channel: "facebook", externalId: PAGE, displayName: "Page",
      });

      const unconfigured = await clientConnectivity(db, f.organisationId, f.clientId, { reachablePageIds: null, instagramByPageId: {} });
      expect(byKey(unconfigured.checks, "fb_page")).toMatchObject({ state: "blocked", owner: "platform" });

      const refused = await clientConnectivity(db, f.organisationId, f.clientId, {
        reachablePageIds: [], instagramByPageId: {}, error: "graph timed out",
      });
      expect(byKey(refused.checks, "fb_page")).toMatchObject({ state: "blocked", owner: "platform" });
      expect(byKey(refused.checks, "fb_page").detail).toMatch(/timed out/);
    });
  });

  it("separates an Instagram that is not linked from one linked but not recorded", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { socialPostsPerMonth: 8 });
      await db.insert(schema.contentChannels).values({
        organisationId: f.organisationId, clientId: f.clientId, channel: "facebook", externalId: PAGE, displayName: "Page",
      });

      // Reachable Page, no Instagram on it — their job, and no API can fix it.
      const none = await clientConnectivity(db, f.organisationId, f.clientId, {
        reachablePageIds: [PAGE], instagramByPageId: { [PAGE]: null },
      });
      expect(byKey(none.checks, "ig")).toMatchObject({ state: "missing", owner: "client" });
      expect(byKey(none.checks, "ig").next).toMatch(/Business or Creator/);

      // Linked on Meta's side but no channel row here — Shoji's job, nothing to type.
      const linked = await clientConnectivity(db, f.organisationId, f.clientId, {
        reachablePageIds: [PAGE], instagramByPageId: { [PAGE]: "17841458211683144" },
      });
      expect(byKey(linked.checks, "ig")).toMatchObject({ state: "missing", owner: "owner" });

      await db.insert(schema.contentChannels).values({
        organisationId: f.organisationId, clientId: f.clientId, channel: "instagram", externalId: "17841458211683144", displayName: "IG",
      });
      const done = await clientConnectivity(db, f.organisationId, f.clientId, {
        reachablePageIds: [PAGE], instagramByPageId: { [PAGE]: "17841458211683144" },
      });
      expect(byKey(done.checks, "ig").state).toBe("ok");
    });
  });

  /** The green Shoji is waiting for, and it has to be reachable. */
  it("goes complete when everything the plan needs is in place", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, {});
      const [site] = await db.insert(schema.sites).values({
        organisationId: f.organisationId, clientId: f.clientId, name: "Site", primaryUrl: "https://tg.example",
      }).returning();
      await db.insert(schema.monitors).values({ organisationId: f.organisationId, siteId: site!.id, target: "https://tg.example" });
      const userId = randomUUID();
      await db.insert(schema.user).values({ id: userId, name: "Dean", email: `d-${userId}@example.test`, emailVerified: true });
      await db.insert(schema.clientUsers).values({ organisationId: f.organisationId, clientId: f.clientId, userId, status: "active" });
      await db.insert(schema.subscriptions).values({
        organisationId: f.organisationId, clientId: f.clientId, status: "active", amountPence: 4500,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 2_592_000_000),
      });

      const state = await clientConnectivity(db, f.organisationId, f.clientId);
      expect(state.complete).toBe(true);
      expect(state.ready).toBe(state.total);
    });
  });

  it("refuses another organisation's client", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db, {});
      const theirs = await fixture(db, {});
      await expect(clientConnectivity(db, mine.organisationId, theirs.clientId)).rejects.toThrow();
    });
  });

  it("says the package is missing before anything else can be judged", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, {});
      await db.update(schema.clients).set({ packageId: null }).where(eq(schema.clients.id, f.clientId));
      const state = await clientConnectivity(db, f.organisationId, f.clientId);
      expect(byKey(state.checks, "package")).toMatchObject({ state: "missing", owner: "owner" });
      expect(state.packageName).toBeNull();
    });
  });
});
