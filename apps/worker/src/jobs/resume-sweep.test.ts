import { describe, expect, it, vi } from "vitest";
import { decideApproval } from "@launchos/core";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FakeLlmClient, defineTool, resumeAgent, runAgent, toolUse, type AgentDefinition } from "@launchos/agents";
import type { BossSender } from "./dispatch-event.js";
import { RUN_STUCK_AFTER_MS, runResumeSweep, runStuckRunSweep } from "./resume-sweep.js";

const sendMail = defineTool({
  name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async () => ({ sent: true }),
});
const agent: AgentDefinition = {
  key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" },
  systemPrompt: "You test.", tools: [sendMail], maxTurns: 3,
};

const LATER = new Date(Date.now() + 60_000);

function silentLogger() {
  return { error: vi.fn(), info: vi.fn() };
}

function fakeBoss() {
  const sent: { name: string; job: unknown; opts: unknown }[] = [];
  const boss: BossSender = {
    send: (async (name: string, job: unknown, opts: unknown) => {
      sent.push({ name, job, opts });
      return "job-id";
    }) as BossSender["send"],
  };
  return { boss, sent };
}

/** A run parked on an approval in an existing organisation, with the decision recorded. */
async function parkedAndDecidedIn(
  db: Db,
  organisationId: string,
  opts: { decision?: "approved" | "rejected"; note?: string } = {},
) {
  const run = await runAgent(agent, {
    db, organisationId, trigger: "manual", payload: {},
    llm: new FakeLlmClient([{
      content: [toolUse("tu_1", "send_mail", { to: "jo@c.test" })],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    }]),
    policy: "safe", logger: console,
  });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  await decideApproval(db, organisationId, {
    approvalId: approval!.id,
    decision: opts.decision ?? "approved",
    decidedByUserId: "u1",
    ...(opts.note ? { note: opts.note } : {}),
  });
  return { organisationId, runId: run.runId, approvalId: approval!.id };
}

/** The same, in a fresh organisation. */
async function parkedAndDecided(db: Db, opts: { decision?: "approved" | "rejected"; note?: string } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sweep-${crypto.randomUUID()}` }).returning();
  return parkedAndDecidedIn(db, org!.id, opts);
}

describe("runResumeSweep", () => {
  it("re-enqueues a decision whose resume never arrived, under the same per-approval key", async () => {
    await withTestDb(async (db) => {
      const { organisationId, runId, approvalId } = await parkedAndDecided(db, { note: "send it" });
      const { boss, sent } = fakeBoss();

      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, LATER);

      expect(sent).toEqual([{
        name: "agent.resume",
        job: { organisationId, runId, approvalId, decision: "approved", note: "send it" },
        // The same key the web request uses, so a job already queued is deduped
        // rather than delivered twice.
        opts: { singletonKey: `resume:${approvalId}` },
      }]);
    });
  });

  it("leaves a decision whose resume already ran alone: the run is no longer parked", async () => {
    await withTestDb(async (db) => {
      const { organisationId, runId } = await parkedAndDecided(db);
      // What a finished resume leaves behind: a terminal run with no
      // `metadata.pending`. There is nothing left to drive.
      await db.update(schema.agentRuns)
        .set({ status: "completed", metadata: {} })
        .where(eq(schema.agentRuns.id, runId));
      const { boss, sent } = fakeBoss();

      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, LATER);

      expect(sent).toEqual([]);
    });
  });

  it("leaves a decision younger than the delivery window alone, so the normal path is never doubled", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await parkedAndDecided(db);
      const { boss, sent } = fakeBoss();

      // `now` is the instant of the decision: the web request's own enqueue has
      // not even returned yet.
      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, new Date());

      expect(sent).toEqual([]);
    });
  });

  it("gives up on a decision a day old, so a resume that can never work is not retried for ever", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await parkedAndDecided(db);
      const { boss, sent } = fakeBoss();

      // Every pg-boss retry is long spent by now: this fails for a reason
      // re-sending cannot fix, and re-enqueueing it every minute would bury
      // every real failure in the log.
      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, new Date(Date.now() + 25 * 60 * 60_000));

      expect(sent).toEqual([]);
    });
  });

  it("leaves a spent decision alone once the run has re-parked on a later tool call", async () => {
    await withTestDb(async (db) => {
      const { organisationId, runId, approvalId } = await parkedAndDecided(db);
      // The ordinary two-approval shape: the Sentinel sends one report, the
      // model asks to send a second, and the run parks again. The first
      // approval is still `approved` and still inside the 24h window, and the
      // run is `awaiting_approval` with `metadata.pending` present again — so
      // every predicate but the tool_use binding still matches it.
      const reparked = await resumeAgent(agent, {
        db, organisationId, runId, approvalId, decision: "approved", policy: "safe", logger: console,
        llm: new FakeLlmClient([{
          content: [toolUse("tu_2", "send_mail", { to: "second@c.test" })],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        }]),
      });
      expect(reparked.status).toBe("awaiting_approval");
      const { boss, sent } = fakeBoss();

      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, LATER);

      // Without the tool_use join this re-enqueues once a minute for 24 hours,
      // and the kernel refuses every one of them.
      expect(sent).toEqual([]);
    });
  });

  it("leaves another organisation's decided approval alone", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await parkedAndDecided(db);
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `sweep-${crypto.randomUUID()}` }).returning();
      const { boss, sent } = fakeBoss();

      await runResumeSweep({ db, boss, logger: silentLogger() }, other!.id, LATER);
      expect(sent).toEqual([]);

      // …and the row really was sweepable, just not from there.
      await runResumeSweep({ db, boss, logger: silentLogger() }, organisationId, LATER);
      expect(sent).toHaveLength(1);
    });
  });

  it("costs only its own item when a send throws, and still fails the job", async () => {
    await withTestDb(async (db) => {
      const first = await parkedAndDecided(db);
      // A second parked, decided approval in the same organisation.
      const second = await parkedAndDecidedIn(db, first.organisationId);
      const sent: string[] = [];
      const boss: BossSender = {
        send: (async (_name: string, job: { approvalId: string }) => {
          if (job.approvalId === first.approvalId) throw new Error("pg-boss is down");
          sent.push(job.approvalId);
          return "job-id";
        }) as BossSender["send"],
      };

      // The whole list is swept, then the failure is re-thrown once so pg-boss
      // retries the cron job — one bad row must not cost the others their turn.
      await expect(
        runResumeSweep({ db, boss, logger: silentLogger() }, first.organisationId, LATER),
      ).rejects.toThrow(/1 of 2 failed/);
      expect(sent).toEqual([second.approvalId]);
    });
  });

  it("leaves an undecided approval alone", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sweep-${crypto.randomUUID()}` }).returning();
      await runAgent(agent, {
        db, organisationId: org!.id, trigger: "manual", payload: {},
        llm: new FakeLlmClient([{
          content: [toolUse("tu_1", "send_mail", { to: "jo@c.test" })],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        }]),
        policy: "safe", logger: console,
      });
      const { boss, sent } = fakeBoss();

      await runResumeSweep({ db, boss, logger: silentLogger() }, org!.id, LATER);

      expect(sent).toEqual([]);
    });
  });
});

describe("runStuckRunSweep", () => {
  async function runningRun(db: Db, metadata: Record<string, unknown> = {}) {
    const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `stuck-${crypto.randomUUID()}` }).returning();
    const [run] = await db.insert(schema.agentRuns)
      .values({ organisationId: org!.id, agentKey: "test-agent", trigger: "resume", status: "running", metadata })
      .returning();
    return { organisationId: org!.id, runId: run!.id };
  }

  it("fails a run whose claim and last activity are older than the window, and audits it", async () => {
    await withTestDb(async (db) => {
      const claimedAt = new Date(Date.now() - 45 * 60_000).toISOString();
      const { organisationId, runId } = await runningRun(db, { resume: { approvalId: "a1", claimedAt } });

      const later = new Date(Date.now() + RUN_STUCK_AFTER_MS + 60_000);
      await runStuckRunSweep({ db, logger: silentLogger() }, organisationId, later);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row!.status).toBe("failed");
      expect(row!.error).toMatch(/Stranded/);
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, runId));
      expect(audits.map((a) => a.action)).toEqual(["agent.run_stranded"]);
    });
  });

  it("leaves a run that recorded a step moments ago alone, however long it has been going", async () => {
    await withTestDb(async (db) => {
      const claimedAt = new Date(Date.now() - 45 * 60_000).toISOString();
      const { organisationId, runId } = await runningRun(db, { resume: { approvalId: "a1", claimedAt } });
      // A long Opus run that is visibly working.
      await db.insert(schema.agentSteps).values({ organisationId, runId, seq: 1, kind: "llm" });

      await runStuckRunSweep({ db, logger: silentLogger() }, organisationId, new Date());

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row!.status).toBe("running");
      expect(row!.error).toBeNull();
    });
  });

  it("is a no-op on a run that finished between the read and the write", async () => {
    await withTestDb(async (db) => {
      const claimedAt = new Date(Date.now() - 45 * 60_000).toISOString();
      const { organisationId, runId } = await runningRun(db, { resume: { approvalId: "a1", claimedAt } });
      // The `status = 'running'` predicate on the UPDATE is what makes this
      // safe; `RunRecorder.finish` carries the same one from the other side.
      await db.update(schema.agentRuns).set({ status: "completed" }).where(eq(schema.agentRuns.id, runId));

      const later = new Date(Date.now() + RUN_STUCK_AFTER_MS + 60_000);
      await runStuckRunSweep({ db, logger: silentLogger() }, organisationId, later);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      expect(row!.status).toBe("completed");
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, runId));
      expect(audits).toEqual([]);
    });
  });
});
