import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { decideApproval } from "@launchos/core";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, text, toolUse } from "./llm.js";
import { resumeAgent } from "./resume-agent.js";
import { runAgent } from "./run-agent.js";
import { defineTool, type AgentDefinition } from "./types.js";

const pingCalls: unknown[] = [];
const ping = defineTool({
  name: "ping",
  description: "ping",
  input: z.object({ host: z.string() }),
  risk: "safe",
  execute: async (input) => {
    pingCalls.push(input);
    return { ok: true };
  },
});
const sendMailCalls: unknown[] = [];
const sendMail = defineTool({
  name: "send_mail",
  description: "send",
  input: z.object({ to: z.string() }),
  risk: "requires_approval",
  execute: async (input) => {
    sendMailCalls.push(input);
    return { sent: true };
  },
});

const agent: AgentDefinition = {
  key: "test-agent",
  name: "Test",
  description: "",
  trigger: { kind: "manual" },
  systemPrompt: "You test.",
  tools: [ping, sendMail],
  maxTurns: 4,
};

async function park(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const llm = new FakeLlmClient([
    {
      content: [
        toolUse("tu_a", "ping", { host: "a.test" }),
        toolUse("tu_b", "send_mail", { to: "jo@c.test" }),
        toolUse("tu_c", "ping", { host: "b.test" }),
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const run = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  return { organisationId: org!.id, run, approval: approval! };
}

/**
 * What the admin portal does before the resume job is queued: `decideApproval`
 * is the single writer of the decision, and the kernel reads it back off the
 * row. A resume against a still-`pending` approval is refused.
 */
async function decide(
  db: Db,
  organisationId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  decidedByUserId = "user_42",
  note?: string,
) {
  await decideApproval(db, organisationId, { approvalId, decision, decidedByUserId, ...(note ? { note } : {}) });
}

/** A resume claim old enough for `failStrandedRun` to treat the run as abandoned. */
const abandonedClaim = (approvalId: string) => ({
  approvalId,
  claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
});

describe("resumeAgent", () => {
  beforeEach(() => {
    pingCalls.length = 0;
    sendMailCalls.length = 0;
  });

  it("executes the approved tool, skips the remaining tool uses and completes the run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      expect(run.status).toBe("awaiting_approval");
      pingCalls.length = 0;
      await decide(db, organisationId, approval.id, "approved", "user_42");

      const llm = new FakeLlmClient([
        { content: [text("Reply sent.")], stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 2 } },
      ]);
      // No decision, note or approver in the options: the kernel reads all
      // three off the approvals row, so a job payload cannot re-attribute them.
      const resumed = await resumeAgent(agent, {
        db,
        organisationId,
        runId: run.runId,
        approvalId: approval.id,
        llm,
        policy: "safe",
        logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.runId).toBe(run.runId);
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);
      // The already-completed ping is replayed from metadata, not re-executed.
      expect(pingCalls).toEqual([]);

      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: unknown }>;
      expect(results.map((r) => r.tool_use_id)).toEqual(["tu_a", "tu_b", "tu_c"]);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.is_error).toBe(true);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.content).toBe("skipped pending approval");

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
      expect(row!.finishedAt).toBeInstanceOf(Date);
      expect(row!.metadata).toEqual({});

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, run.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.seq)).toEqual([...steps.keys()].map((i) => i + 1)); // seq continues, never restarts
      expect(steps.map((s) => s.kind)).toContain("tool_result");

      // The skipped remainder is visible in the trace, not only to the model.
      const skipNote = steps.find((s) => s.kind === "note");
      expect(skipNote!.output).toMatchObject({ skippedToolUseIds: ["tu_c"], reason: "skipped pending approval" });

      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedAt).toBeInstanceOf(Date);
      expect(decided!.decidedBy).toBe("user_42");
    });
  });

  it("feeds a rejection back to the model instead of running the tool", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "rejected", "user_42", "Wrong tone");
      const llm = new FakeLlmClient([
        { content: [text("Understood, escalating instead.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      // The rejection and its reason come from the row, not from the caller.
      const resumed = await resumeAgent(agent, {
        db,
        organisationId,
        runId: run.runId,
        approvalId: approval.id,
        llm,
        policy: "safe",
        logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(sendMailCalls).toEqual([]);
      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: string }>;
      const rejected = results.find((r) => r.tool_use_id === "tu_b")!;
      expect(rejected.is_error).toBe(true);
      expect(rejected.content).toBe("rejected by human: Wrong tone");

      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(decided!.status).toBe("rejected");
      expect(decided!.decisionNote).toBe("Wrong tone");
    });
  });

  it("refuses to resume a run that is not awaiting approval", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      await db.update(schema.agentRuns).set({ status: "completed" }).where(eq(schema.agentRuns.id, run.runId));
      await expect(
        resumeAgent(agent, {
          db,
          organisationId,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/awaiting_approval/);
    });
  });

  it("refuses to replay a spent approval against a tool_use the human never saw", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");

      // First resume approves tu_b; the model immediately parks a *new* send_mail.
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_d", "send_mail", { to: "second@c.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const reparked = await resumeAgent(agent, {
        db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved", llm, policy: "safe", logger: console,
      });
      expect(reparked.status).toBe("awaiting_approval");
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);

      // Replaying the spent approval must not spend it again on tu_d.
      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/approves tool_use tu_b, but run .* is awaiting tu_d/);
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("awaiting_approval"); // still parked, still resumable by the right approval
    });
  });

  it("ends the run failed when a resume throws, rather than leaving it running", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      const exploding: AgentDefinition = {
        ...agent,
        tools: [
          ping,
          defineTool({
            name: "send_mail",
            description: "send",
            input: z.object({ to: z.string() }),
            risk: "requires_approval",
            execute: async () => {
              throw new Error("smtp exploded");
            },
          }),
        ],
      };

      // The tool's failure goes back to the model, and the model call is the
      // next thing to fail. Whatever breaks, the run must land somewhere
      // terminal: a run left `running` is one nothing ever picks up again.
      const resumed = await resumeAgent(exploding, {
        db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
        llm: new FakeLlmClient([]), policy: "safe", logger: console,
      });

      expect(resumed.status).toBe("failed");
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("failed");
      expect(row!.error).toBeTruthy();
      expect(row!.finishedAt).toBeInstanceOf(Date);
    });
  });

  it("fails a run stranded in running by a killed resume, and tells the owner", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      // An earlier delivery for *this* approval claimed the run, stamped the
      // claim and was killed, long enough ago that nothing can still be driving it.
      const [claimedRun] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      await db.update(schema.agentRuns)
        .set({ status: "running", metadata: { ...claimedRun!.metadata, resume: abandonedClaim(approval.id) } })
        .where(eq(schema.agentRuns.id, run.runId));
      const [user] = await db.insert(schema.user)
        .values({ id: `u-${crypto.randomUUID()}`, name: "Shoji", email: `${crypto.randomUUID()}@t.test` })
        .returning();
      await db.insert(schema.organisationMembers)
        .values({ organisationId, userId: user!.id, role: "owner", status: "active" });

      const resumed = await resumeAgent(agent, {
        db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
        llm: new FakeLlmClient([]), policy: "safe", logger: console,
      });

      // Terminal and visible, rather than retried for ever against a lost claim.
      expect(resumed.status).toBe("failed");
      expect(sendMailCalls).toEqual([]);
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("failed");
      expect(row!.error).toMatch(/is running, expected awaiting_approval/);
      expect(row!.finishedAt).toBeInstanceOf(Date);

      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.userId, user!.id));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.kind).toBe("agent.resume_failed");
      expect(notifications[0]!.link).toBe(`/agents/runs/${run.runId}`);
    });
  });

  it("refuses an approval nobody has decided yet", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);

      // `decideApproval` records the decision before the job is queued, so a
      // still-pending row means the resume is running ahead of the human.
      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/is pending, expected a recorded decision/);
      expect(sendMailCalls).toEqual([]);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("awaiting_approval");
      expect(row!.error).toBeNull();
    });
  });

  it("does not fail a running run whose claim is still fresh", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      // A redelivery landing while the first attempt is still working. Failing
      // the run here would tell Shoji an approved send failed while it runs.
      const [live] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      await db.update(schema.agentRuns)
        .set({
          status: "running",
          metadata: { ...live!.metadata, resume: { approvalId: approval.id, claimedAt: new Date().toISOString() } },
        })
        .where(eq(schema.agentRuns.id, run.runId));

      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/is running, expected awaiting_approval/);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("running");
      expect(row!.error).toBeNull();
    });
  });

  it("does not fail a running run that a different approval claimed", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      const [live] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      await db.update(schema.agentRuns)
        .set({ status: "running", metadata: { ...live!.metadata, resume: abandonedClaim(crypto.randomUUID()) } })
        .where(eq(schema.agentRuns.id, run.runId));

      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/is running, expected awaiting_approval/);

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("running");
      expect(row!.error).toBeNull();
    });
  });

  it("refuses an approval bound to a different tool_use id", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      await db
        .update(schema.approvals)
        .set({ payload: { toolName: "send_mail", input: { to: "jo@c.test" }, toolUseId: "tu_zzz" } })
        .where(eq(schema.approvals.id, approval.id));

      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/approves tool_use tu_zzz/);
      expect(sendMailCalls).toEqual([]);
    });
  });

  it("gives a domain error when the run carries no pending state", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      await db.update(schema.agentRuns).set({ metadata: {} }).where(eq(schema.agentRuns.id, run.runId));
      await expect(
        resumeAgent(agent, {
          db, organisationId, runId: run.runId, approvalId: approval.id, decision: "approved",
          llm: new FakeLlmClient([]), policy: "safe", logger: console,
        }),
      ).rejects.toThrow(/no resumable pending state/);
    });
  });

  it("refuses to resume from a different organisation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      const [other] = await db.insert(schema.organisations).values({ name: "O", slug: `o-${crypto.randomUUID()}` }).returning();
      await expect(
        resumeAgent(agent, {
          db,
          organisationId: other!.id,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });

  it("refuses to resume when the approved tool is not registered on the agent", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await decide(db, organisationId, approval.id, "approved");
      const pingOnly: AgentDefinition = { ...agent, tools: [ping] };
      await expect(
        resumeAgent(pingOnly, {
          db,
          organisationId,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/not registered/);
    });
  });
  it("still parks, with the default title, when describeApproval throws", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const blind = defineTool({
        name: "send_mail",
        description: "send",
        input: z.object({ to: z.string() }),
        risk: "requires_approval",
        describeApproval: async () => {
          throw new Error("the client row vanished");
        },
        execute: async (input) => {
          sendMailCalls.push(input);
          return { sent: true };
        },
      });
      const blindAgent: AgentDefinition = { ...agent, tools: [ping, blind] };

      const parked = await runAgent(blindAgent, {
        db, organisationId: org!.id, trigger: "manual", payload: {},
        llm: new FakeLlmClient([
          {
            content: [toolUse("tu_x", "send_mail", { to: "jo@c.test" })],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ]),
        policy: "safe", logger: console,
      });

      // A description that throws must never turn the gate into silence: the
      // card still exists, it just falls back to the default title.
      expect(parked.status).toBe("awaiting_approval");
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, parked.runId));
      expect((row!.metadata as { pending: { awaitingToolUseId: string } }).pending.awaitingToolUseId).toBe("tu_x");
      const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, parked.runId));
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.title).toBe("Test wants to run send_mail");
      expect(approvals[0]!.payload).not.toHaveProperty("description");
      expect(sendMailCalls).toEqual([]);

      // And it is still resumable, so the human decision reaches the tool.
      await decide(db, org!.id, approvals[0]!.id, "approved");
      const resumed = await resumeAgent(blindAgent, {
        db, organisationId: org!.id, runId: parked.runId, approvalId: approvals[0]!.id,
        llm: new FakeLlmClient([
          { content: [text("Sent.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]),
        policy: "safe", logger: console,
      });
      expect(resumed.status).toBe("completed");
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);
    });
  });
});
