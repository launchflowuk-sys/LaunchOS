import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AD_SENTINEL_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildSentinelJobs } from "./ads-sentinel.js";

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
