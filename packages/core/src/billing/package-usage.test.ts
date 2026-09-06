import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { ContentChannel, ContentKind } from "@launchos/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contentFixture, INCLUDES } from "../content/test-fixtures.js";
import { opsMetricsSnapshot } from "../team/ops-metrics.js";
import { packageUsagePressure } from "./package-usage.js";

const NOW = new Date("2026-09-09T06:00:00Z");
const PERIOD = "2026-09";

async function publish(db: Db, organisationId: string, clientId: string, kind: ContentKind, count: number) {
  const channel: ContentChannel = kind === "blog_post" ? "blog" : kind === "gbp_update" ? "gbp" : "facebook";
  if (count === 0) return;
  await db.insert(schema.contentItems).values(
    Array.from({ length: count }, (_, i) => ({
      organisationId, clientId, channel, kind, periodKey: PERIOD, status: "published" as const,
      title: `${kind} ${i + 1}`, publishedAt: new Date("2026-09-05T09:00:00Z"),
    })),
  );
}

async function raiseCase(db: Db, organisationId: string, clientId: string, category: "hosting" | "ads" | "email", at = new Date("2026-09-04T10:00:00Z")) {
  await db.insert(schema.tickets).values({ organisationId, clientId, subject: `${category} question`, category, createdAt: at });
}

describe("package usage pressure", () => {
  it("reports an allowance that has been passed and one that is nearly spent, and stays quiet about the rest", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      // The fixture package includes 4 social, 1 blog, 2 GBP.
      await publish(db, orgId, clientId, "social_post", 5);
      await publish(db, orgId, clientId, "blog_post", 1);
      await publish(db, orgId, clientId, "gbp_update", 1);

      const [pressure, ...rest] = await packageUsagePressure(db, orgId, { now: NOW });
      expect(rest).toEqual([]);
      expect(pressure?.clientId).toBe(clientId);
      expect(pressure?.packageName).toBe("Growth");
      expect(pressure?.periodKey).toBe(PERIOD);
      expect(pressure?.standing).toBe("over");
      // Over first, and the half-used GBP allowance is not mentioned at all.
      expect(pressure?.allowances).toEqual([
        { label: "Social posts", used: 5, allowed: 4, usedPercent: 125 },
        { label: "Blog posts", used: 1, allowed: 1, usedPercent: 100 },
      ]);
    });
  });

  it("puts three quarters of an allowance on the near side of the line and a half on the quiet side", async () => {
    await withTestDb(async (db) => {
      const near = await contentFixture(db, { name: "Nearly there" });
      await publish(db, near.orgId, near.clientId, "social_post", 3);
      const [pressure] = await packageUsagePressure(db, near.orgId, { now: NOW });
      expect(pressure?.standing).toBe("near");
      expect(pressure?.allowances).toEqual([{ label: "Social posts", used: 3, allowed: 4, usedPercent: 75 }]);

      const quiet = await contentFixture(db, { name: "Halfway" });
      await publish(db, quiet.orgId, quiet.clientId, "social_post", 2);
      expect(await packageUsagePressure(db, quiet.orgId, { now: NOW })).toEqual([]);
    });
  });

  it("counts a month by the calendar, not by the last few hours", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      await publish(db, orgId, clientId, "social_post", 5);
      // Published on the 5th and read on the 9th: still this month's spend.
      expect((await packageUsagePressure(db, orgId, { now: NOW }))[0]?.standing).toBe("over");
      // Read in October, the September month is somebody else's problem.
      expect(await packageUsagePressure(db, orgId, { now: new Date("2026-10-01T09:00:00Z") })).toEqual([]);
    });
  });

  it("treats work the package never included as over, and ignores what every client gets", async () => {
    await withTestDb(async (db) => {
      // The fixture package has a website but no ads.
      const { orgId, clientId } = await contentFixture(db);
      await raiseCase(db, orgId, clientId, "ads");
      await raiseCase(db, orgId, clientId, "ads");
      await raiseCase(db, orgId, clientId, "hosting");
      await raiseCase(db, orgId, clientId, "email");
      // Last month's ads question is not this month's.
      await raiseCase(db, orgId, clientId, "ads", new Date("2026-08-20T10:00:00Z"));

      const [pressure] = await packageUsagePressure(db, orgId, { now: NOW });
      expect(pressure?.standing).toBe("over");
      expect(pressure?.allowances).toEqual([
        { label: "Ads support (not in the package)", used: 2, allowed: 0, usedPercent: null },
      ]);
    });
  });

  it("is silent about a client with no package to be near the limits of", async () => {
    await withTestDb(async (db) => {
      const none = await contentFixture(db, { withSubscription: false });
      await publish(db, none.orgId, none.clientId, "social_post", 9);
      expect(await packageUsagePressure(db, none.orgId, { now: NOW })).toEqual([]);

      const cancelled = await contentFixture(db);
      await publish(db, cancelled.orgId, cancelled.clientId, "social_post", 9);
      await db.update(schema.subscriptions).set({ status: "cancelled" })
        .where(eq(schema.subscriptions.id, cancelled.subscription!.id));
      expect(await packageUsagePressure(db, cancelled.orgId, { now: NOW })).toEqual([]);

      const unpackaged = await contentFixture(db);
      await publish(db, unpackaged.orgId, unpackaged.clientId, "social_post", 9);
      await db.update(schema.subscriptions).set({ packageId: null })
        .where(eq(schema.subscriptions.id, unpackaged.subscription!.id));
      expect(await packageUsagePressure(db, unpackaged.orgId, { now: NOW })).toEqual([]);

      const paused = await contentFixture(db);
      await publish(db, paused.orgId, paused.clientId, "social_post", 9);
      await db.update(schema.clients).set({ status: "paused" }).where(eq(schema.clients.id, paused.clientId));
      expect(await packageUsagePressure(db, paused.orgId, { now: NOW })).toEqual([]);
    });
  });

  it("orders the over-the-limit clients above the near ones and never crosses organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await contentFixture(db, { name: "Grays CabLine" });
      await publish(db, mine.orgId, mine.clientId, "social_post", 3);

      // A second client of the same organisation, over rather than near.
      const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, mine.packageId));
      const [second] = await db.insert(schema.clients)
        .values({ organisationId: mine.orgId, name: "Star Grooming", slug: `star-${crypto.randomUUID()}`, packageId: pkg!.id })
        .returning();
      await db.insert(schema.subscriptions).values({
        organisationId: mine.orgId, clientId: second!.id, packageId: pkg!.id, status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-09-30T23:59:59Z"),
        amountPence: 14900,
      });
      await publish(db, mine.orgId, second!.id, "social_post", 6);

      const theirs = await contentFixture(db, { name: "Someone else" });
      await publish(db, theirs.orgId, theirs.clientId, "social_post", 8);

      const ours = await packageUsagePressure(db, mine.orgId, { now: NOW });
      expect(ours.map((row) => [row.clientName, row.standing])).toEqual([
        ["Star Grooming", "over"],
        ["Grays CabLine", "near"],
      ]);
      expect((await packageUsagePressure(db, theirs.orgId, { now: NOW })).map((row) => row.clientName)).toEqual(["Someone else"]);
      // The limit is a payload guard, not a filter on the counting.
      expect((await packageUsagePressure(db, mine.orgId, { now: NOW, limit: 1 })).map((row) => row.clientName)).toEqual(["Star Grooming"]);
    });
  });

  it("reaches the Ops Brief through the metrics snapshot", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      expect(INCLUDES.socialPostsPerMonth).toBe(4);
      await publish(db, orgId, clientId, "social_post", 5);

      const snapshot = await opsMetricsSnapshot(db, orgId, { hours: 24, now: NOW });
      expect(snapshot.packages.overLimit).toBe(1);
      expect(snapshot.packages.nearLimit).toBe(0);
      expect(snapshot.packages.clients[0]?.clientName).toBe("Grays CabLine");
      expect(snapshot.packages.clients[0]?.allowances[0]?.usedPercent).toBe(125);
    });
  });
});
