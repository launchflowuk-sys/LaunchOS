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
  /**
   * What the sweep owes content to: an active client with a content service
   * switched on. A package with no quota no longer excludes anybody — the
   * defaults fill it — which is the reversal that let the writer work for
   * Shoji's legacy clients at all. Archived, lapsed and another tenant's
   * clients are still excluded, and those are the exclusions that matter.
   */
  it("lists active clients with posting switched on, whatever their package includes", async () => {
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

      expect(owed).toContain(f.clientId);
      // Posting is on and the package says nothing: the defaults apply.
      expect(owed).toContain(noQuota.clientId);
      // Still out: nobody paying, nobody active, nobody else's.
      for (const id of [unsubscribed.clientId, archived.clientId, cancelled.clientId, other.clientId]) {
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

      // Three clients now, not two: the hosting-only one has posting switched
      // on and a package that says nothing, so it is planned from the
      // defaults — 4 social + 1 blog + 2 gbp, against 2 + 1 + 1 for the two
      // whose package states its own quantities.
      expect(result).toEqual({ periodKey: PERIOD, clients: 3, created: 15, drafts: 3, skipped: 0, unconnected: 0, failed: 0 });
      expect(await slotsOf(db, f.orgId, f.clientId)).toHaveLength(4);
      expect(await slotsOf(db, f.orgId, second.clientId)).toHaveLength(4);

      expect(sent).toHaveLength(3);
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

  /**
   * A refusal is skipped, not failed — one client the planner turns down must
   * not fail the whole sweep.
   *
   * The refusal used here is the only one left. A subscription with no package
   * used to refuse and no longer does: that client is planned from the
   * defaults. Services switched off is what remains, and it is the one that
   * should remain, because it is the only refusal that represents somebody's
   * decision rather than a billing accident.
   */
  it("counts a client the planner refuses as skipped, not failed, and sends it no draft", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const { boss, sent } = recordingBoss();
      // Owed content by the listing — it reads the switches — and then turned
      // down by the planner, because the switch is taken off in between.
      const owed = await clientsOwedContent(db, f.orgId);
      expect(owed.map((c) => c.clientId)).toEqual([f.clientId]);
      await db.update(schema.clientServices).set({ active: false })
        .where(eq(schema.clientServices.clientId, f.clientId));

      const result = await runPlanMonth({ db, boss, logger: silentLogger() }, f.orgId, NOW);

      expect(result).toMatchObject({ periodKey: PERIOD, created: 0, drafts: 0, failed: 0 });
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
