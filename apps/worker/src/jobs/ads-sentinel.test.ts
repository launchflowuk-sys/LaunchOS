import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AD_SENTINEL_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildSentinelJobs, dispatchSentinelRuns } from "./ads-sentinel.js";
import type { BossSender } from "./dispatch-event.js";

const NOW = new Date("2026-09-04T07:00:00Z");

async function organisation(db: Db, slug: string) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `${slug}-${randomUUID()}` }).returning();
  return org!.id;
}

describe("buildSentinelJobs", () => {
  it("produces one cron agent.run job per organisation with the Sentinel enabled", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db, "sentinel-on");
      await db.insert(schema.agentEnablement)
        .values({ organisationId, agentKey: AD_SENTINEL_KEY, enabled: true });

      const jobs = await buildSentinelJobs(db, NOW);

      expect(jobs.filter((j) => j.organisationId === organisationId)).toEqual([{
        agentKey: AD_SENTINEL_KEY,
        organisationId,
        trigger: "cron",
        payload: { now: NOW.toISOString() },
      }]);
    });
  });

  it("produces no job for an organisation that has the Sentinel disabled", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db, "sentinel-off");
      await db.insert(schema.agentEnablement)
        .values({ organisationId, agentKey: AD_SENTINEL_KEY, enabled: false });

      const jobs = await buildSentinelJobs(db, NOW);

      expect(jobs.filter((j) => j.organisationId === organisationId)).toEqual([]);
    });
  });

  it("ignores enablement rows for other agents", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db, "sentinel-other");
      await db.insert(schema.agentEnablement)
        .values({ organisationId, agentKey: "support-triage", enabled: true });

      const jobs = await buildSentinelJobs(db, NOW);

      expect(jobs.filter((j) => j.organisationId === organisationId)).toEqual([]);
    });
  });

  it("produces nothing for an organisation with no enablement row at all", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db, "sentinel-none");

      const jobs = await buildSentinelJobs(db, NOW);

      expect(jobs.filter((j) => j.organisationId === organisationId)).toEqual([]);
    });
  });
});

function silentLogger() {
  return { error: vi.fn(), info: vi.fn() };
}

describe("dispatchSentinelRuns", () => {
  it("enqueues an agent.run per enabled organisation, keyed per organisation per day", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db, "fanout-on");
      await db.insert(schema.agentEnablement)
        .values({ organisationId, agentKey: AD_SENTINEL_KEY, enabled: true });
      const sent: { name: string; job: unknown; opts: unknown }[] = [];
      const boss: BossSender = {
        send: (async (name: string, job: unknown, opts: unknown) => {
          sent.push({ name, job, opts });
          return "job-id";
        }) as BossSender["send"],
      };

      await dispatchSentinelRuns({ db, boss, logger: silentLogger() }, NOW);

      const mine = sent.filter((s) => (s.job as { organisationId: string }).organisationId === organisationId);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.name).toBe("agent.run");
      // Per organisation per UTC day, under a window, so a retry of the fan-out
      // cannot start a second Opus-priced run for an organisation already sent.
      expect(mine[0]!.opts).toEqual({
        singletonKey: `ad-sentinel:${organisationId}:2026-09-04`,
        singletonSeconds: 86_400,
      });
    });
  });

  it("still dispatches the other organisations when one enqueue throws, then fails the job", async () => {
    await withTestDb(async (db) => {
      const bad = await organisation(db, "fanout-bad");
      const good = await organisation(db, "fanout-good");
      for (const organisationId of [bad, good]) {
        await db.insert(schema.agentEnablement)
          .values({ organisationId, agentKey: AD_SENTINEL_KEY, enabled: true });
      }
      const dispatched: string[] = [];
      const boss: BossSender = {
        send: (async (_name: string, job: { organisationId: string }) => {
          if (job.organisationId === bad) throw new Error("send failed");
          dispatched.push(job.organisationId);
          return "job-id";
        }) as unknown as BossSender["send"],
      };

      await expect(dispatchSentinelRuns({ db, boss, logger: silentLogger() }, NOW))
        .rejects.toThrow(AggregateError);

      expect(dispatched).toContain(good);
    });
  });
});
