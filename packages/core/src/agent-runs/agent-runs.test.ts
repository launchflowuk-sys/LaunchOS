import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { agentRunHealth, listAgentKeys, listAgentRuns } from "./list-runs.js";

const NOW = new Date("2026-09-06T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function organisation(db: Db) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "LaunchFlow", slug: `ar-${randomUUID()}` }).returning();
  return org!.id;
}

/** One run, with `steps` steps recorded against it. */
async function run(
  db: Db,
  organisationId: string,
  options: {
    agentKey: string;
    status?: "running" | "completed" | "awaiting_approval" | "failed";
    trigger?: "cron" | "event" | "manual" | "resume";
    startedAt: Date;
    finishedAt?: Date | null;
    steps?: number;
  },
) {
  const [row] = await db.insert(schema.agentRuns).values({
    organisationId,
    agentKey: options.agentKey,
    trigger: options.trigger ?? "cron",
    status: options.status ?? "completed",
    startedAt: options.startedAt,
    finishedAt: options.finishedAt ?? null,
  }).returning();
  for (let seq = 0; seq < (options.steps ?? 0); seq += 1) {
    await db.insert(schema.agentSteps).values({
      organisationId, runId: row!.id, seq, kind: "note", input: {}, output: {},
    });
  }
  return row!;
}

describe("the agent run ledger", () => {
  it("lists runs newest first with their step counts and how long each took", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db);
      const older = await run(db, organisationId, {
        agentKey: "content-writer", startedAt: minutes(60), finishedAt: minutes(58), steps: 3,
      });
      const newer = await run(db, organisationId, {
        agentKey: "ops-brief", startedAt: minutes(10), finishedAt: minutes(9), steps: 1,
      });
      // Still going, so it has no duration to report yet.
      const live = await run(db, organisationId, {
        agentKey: "lead-qualifier", status: "running", startedAt: minutes(1), steps: 0,
      });

      const { runs, total } = await listAgentRuns(db, organisationId);

      expect(total).toBe(3);
      expect(runs.map((r) => r.id)).toEqual([live.id, newer.id, older.id]);
      expect(runs.map((r) => r.steps)).toEqual([0, 1, 3]);
      expect(runs[0]!.durationMs).toBeNull();
      expect(runs[2]!.durationMs).toBe(2 * 60_000);
    });
  });

  it("filters by agent, status and trigger, and counts every match rather than the page", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db);
      for (let i = 0; i < 3; i += 1) {
        await run(db, organisationId, { agentKey: "content-writer", status: "failed", trigger: "cron", startedAt: minutes(30 + i) });
      }
      await run(db, organisationId, { agentKey: "content-writer", status: "completed", trigger: "manual", startedAt: minutes(5) });
      await run(db, organisationId, { agentKey: "ops-brief", status: "failed", trigger: "cron", startedAt: minutes(2) });

      expect((await listAgentRuns(db, organisationId, { agentKey: "content-writer" })).total).toBe(4);
      expect((await listAgentRuns(db, organisationId, { status: "failed" })).total).toBe(4);
      expect((await listAgentRuns(db, organisationId, { trigger: "manual" })).total).toBe(1);
      expect((await listAgentRuns(db, organisationId, { agentKey: "content-writer", status: "failed" })).total).toBe(3);

      // A page is a window on the total, not the total.
      const page = await listAgentRuns(db, organisationId, { limit: 2 });
      expect(page.runs).toHaveLength(2);
      expect(page.total).toBe(5);
      const second = await listAgentRuns(db, organisationId, { limit: 2, offset: 2 });
      expect(second.runs.map((r) => r.id)).not.toEqual(page.runs.map((r) => r.id));
    });
  });

  it("counts the recent window by status, and lists the agent keys that have actually run", async () => {
    await withTestDb(async (db) => {
      const organisationId = await organisation(db);
      await run(db, organisationId, { agentKey: "content-writer", status: "failed", startedAt: minutes(30) });
      await run(db, organisationId, { agentKey: "content-writer", status: "completed", startedAt: minutes(20) });
      await run(db, organisationId, { agentKey: "ops-brief", status: "awaiting_approval", startedAt: minutes(10) });
      // Outside the window: old news is not this week's health.
      await run(db, organisationId, { agentKey: "hosting-guard-dog", status: "failed", startedAt: minutes(60 * 24 * 30) });

      const health = await agentRunHealth(db, organisationId, minutes(60));
      expect(health).toEqual({ running: 0, completed: 1, awaiting_approval: 1, failed: 1 });

      expect(await listAgentKeys(db, organisationId)).toEqual(["content-writer", "hosting-guard-dog", "ops-brief"]);
    });
  });

  it("shows another organisation nothing at all", async () => {
    await withTestDb(async (db) => {
      const mine = await organisation(db);
      const theirs = await organisation(db);
      await run(db, mine, { agentKey: "content-writer", startedAt: minutes(5), steps: 2 });

      expect(await listAgentRuns(db, theirs)).toEqual({ runs: [], total: 0 });
      expect(await listAgentKeys(db, theirs)).toEqual([]);
      expect(await agentRunHealth(db, theirs, minutes(60))).toEqual({ running: 0, completed: 0, awaiting_approval: 0, failed: 0 });
    });
  });

  it("does not count another organisation's steps against my run", async () => {
    await withTestDb(async (db) => {
      const mine = await organisation(db);
      const theirs = await organisation(db);
      const row = await run(db, mine, { agentKey: "content-writer", startedAt: minutes(5), steps: 2 });
      // A step row pointing at my run but stamped with their organisation is
      // not mine to count; the join filters on both, not just the run id.
      await db.insert(schema.agentSteps).values({
        organisationId: theirs, runId: row.id, seq: 99, kind: "note", input: {}, output: {},
      });

      const { runs } = await listAgentRuns(db, mine);
      expect(runs[0]!.steps).toBe(2);
    });
  });
});
