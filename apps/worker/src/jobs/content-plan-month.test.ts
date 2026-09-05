import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { QUEUE } from "../boss.js";
import { clientsOwedContent, contentDraftKey, runPlanMonth } from "./content-plan-month.js";
import { addClient, contentJobFixture, silentLogger } from "./content-test-fixture.js";
import type { BossSender } from "./dispatch-event.js";

// 06:00 London on 1 September 2026 (BST), the cron's own moment.
const NOW = new Date("2026-09-01T05:00:00Z");
const PERIOD = "2026-09";
const NO_QUOTA = { website: true, seo: true, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 };

function recordingBoss() {
  const sent: { name: string; job: unknown; opts: unknown }[] = [];
  const boss: BossSender = {
    send: (async (name: string, job: unknown, opts: unknown) => {
      sent.push({ name, job, opts });
      return "job-id";
    }) as BossSender["send"],
  };
  return { boss, sent };
}

function slotsOf(db: Parameters<typeof runPlanMonth>[0]["db"], orgId: string, clientId: string) {
  return db.select().from(schema.contentItems).where(and(
    eq(schema.contentItems.organisationId, orgId), eq(schema.contentItems.clientId, clientId), eq(schema.contentItems.periodKey, PERIOD),
  ));
}

describe("clientsOwedContent", () => {
  it("lists subscribed active clients whose package has a quota, and nobody else", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const noQuota = await addClient(db, f.orgId, { name: "Hosting only", includes: NO_QUOTA });
      const unsubscribed = await addClient(db, f.orgId, { name: "Lapsed", subscribed: false });
      const archived = await addClient(db, f.orgId, { name: "Archived" });
      await db.update(schema.clients).set({ status: "archived" }).where(eq(schema.clients.id, archived.clientId));
      const cancelled = await addClient(db, f.orgId, { name: "Cancelled" });
      await db.update(schema.subscriptions).set({ status: "cancelled" }).where(eq(schema.subscriptions.clientId, cancelled.clientId));
      const other = await contentJobFixture(db);

      const owed = (await clientsOwedContent(db, f.orgId)).map((c) => c.clientId);

      expect(owed).toEqual([f.clientId]);
      for (const id of [noQuota.clientId, unsubscribed.clientId, archived.clientId, cancelled.clientId, other.clientId]) {
        expect(owed).not.toContain(id);
      }
    });
  });
});

describe("runPlanMonth", () => {
  it("lays out the month for each client owed content and starts one writer run per client", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const second = await addClient(db, f.orgId, { name: "Second" });
      await addClient(db, f.orgId, { name: "Hosting only", includes: NO_QUOTA });
      const { boss, sent } = recordingBoss();

      const result = await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);

      // 2 social + 1 blog + 1 gbp per client.
      expect(result).toEqual({ periodKey: PERIOD, clients: 2, created: 8, drafts: 2, skipped: 0, failed: 0 });
      expect(await slotsOf(db, f.orgId, f.clientId)).toHaveLength(4);
      expect(await slotsOf(db, f.orgId, second.clientId)).toHaveLength(4);

      expect(sent).toHaveLength(2);
      const mine = sent.find((s) => (s.job as { clientId: string }).clientId === f.clientId)!;
      expect(mine.name).toBe(QUEUE.contentDraft);
      expect(mine.job).toEqual({ organisationId: f.orgId, clientId: f.clientId, periodKey: PERIOD, trigger: "cron" });
      // Once per client per month per day, whatever happens to the first run.
      expect(mine.opts).toEqual({ singletonKey: contentDraftKey(f.clientId, PERIOD), singletonSeconds: 86_400 });
    });
  });

  it("is idempotent: a second run creates no slot and, once the month is written, sends no draft", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const { boss, sent } = recordingBoss();
      await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);

      // The retry case: same day, slots still empty. No new slots, and the
      // draft is sent again under the same key — pg-boss's window collapses it.
      const again = await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);
      expect(again).toMatchObject({ created: 0, drafts: 1 });
      expect(await slotsOf(db, f.orgId, f.clientId)).toHaveLength(4);
      expect(new Set(sent.map((s) => (s.opts as { singletonKey: string }).singletonKey)).size).toBe(1);

      // Once every slot has a body there is nothing to draft.
      await db.update(schema.contentItems).set({ body: "Written." })
        .where(and(eq(schema.contentItems.clientId, f.clientId), eq(schema.contentItems.periodKey, PERIOD)));
      const written = await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);
      expect(written).toMatchObject({ created: 0, drafts: 0 });
      expect(sent).toHaveLength(2);
    });
  });

  it("counts a client the planner refuses as skipped, not failed, and sends it no draft", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const { boss, sent } = recordingBoss();
      // Two live subscriptions: the listing sees the packaged one, but
      // `planContentMonth` reads the oldest, which has no package and refuses.
      await db.insert(schema.subscriptions).values({
        organisationId: f.orgId, clientId: f.clientId, packageId: null, status: "active",
        currentPeriodStart: new Date("2026-01-01T00:00:00Z"), currentPeriodEnd: new Date("2026-12-31T23:59:59Z"),
        amountPence: 0, currency: "GBP", createdAt: new Date("2025-01-01T00:00:00Z"),
      });

      const result = await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);

      expect(result).toEqual({ periodKey: PERIOD, clients: 1, created: 0, drafts: 0, skipped: 1, failed: 0 });
      expect(sent).toEqual([]);
      expect(await slotsOf(db, f.orgId, f.clientId)).toHaveLength(0);
    });
  });

  it("still plans and dispatches the other clients when one enqueue throws, then fails the job", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const good = await addClient(db, f.orgId, { name: "Good" });
      const dispatched: string[] = [];
      const boss: BossSender = {
        send: (async (_name: string, job: { clientId: string }) => {
          if (job.clientId === f.clientId) throw new Error("send failed");
          dispatched.push(job.clientId);
          return "job-id";
        }) as unknown as BossSender["send"],
      };

      await expect(runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW)).rejects.toThrow(AggregateError);

      expect(dispatched).toEqual([good.clientId]);
      // The failed client's slots were still laid out; only its draft is missing.
      expect(await slotsOf(db, f.orgId, f.clientId)).toHaveLength(4);
    });
  });
});
