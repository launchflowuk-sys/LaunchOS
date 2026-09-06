import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applyContentPublishDecision, claimDueContent, decideApproval } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockImageGenAdapter } from "@launchos/integrations";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { PERIOD, writerFixture } from "./fixture.js";
import { CONTENT_WRITER_KEY, contentWriter } from "./index.js";

const NOW = new Date("2026-09-01T06:00:00Z");
const usage = { inputTokens: 1, outputTokens: 1 };
const quiet = { info() {}, warn() {}, error() {} };

/** The writer under test always runs on the mock generator: no key, no network, no spend. */
const imagegen = new MockImageGenAdapter();
const writer = () => contentWriter(imagegen);

// `content_render_image` writes the picture to STORAGE_DIR, so the one test
// that lets the writer draw one needs somewhere to put it. Set on process.env
// rather than passed in: the tool calls core with the process environment, the
// way the worker does.
let storage: string;
let previousStorage: string | undefined;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "launchos-writer-images-"));
  previousStorage = process.env["STORAGE_DIR"];
  process.env["STORAGE_DIR"] = storage;
});
afterAll(async () => {
  if (previousStorage === undefined) delete process.env["STORAGE_DIR"];
  else process.env["STORAGE_DIR"] = previousStorage;
  await rm(storage, { recursive: true, force: true });
});

describe("content-writer", () => {
  it("carries the asset tool and tells the model to pick a photo per social slot, with every tool safe", () => {
    const agent = writer();
    expect(agent.tools.map((t) => t.name)).toEqual([
      "content_get_brief", "knowledge_search", "content_list_slots", "content_list_assets", "content_save_draft",
      "content_render_image", "content_request_approval",
    ]);
    // Drawing a picture onto a draft nobody outside the office can see is not
    // an outward act; the content_publish card is still the only one there is.
    expect(agent.tools.every((t) => t.risk === "safe")).toBe(true);
    expect(agent.systemPrompt).toMatch(/content_list_assets once/);
    expect(agent.systemPrompt).toMatch(/pass its url as imageUrl/);
    expect(agent.systemPrompt).toMatch(/Never pass an image url from anywhere else/);
    expect(agent.systemPrompt).toMatch(/call content_render_image once with that slot's itemId/);
    expect(agent.systemPrompt).toMatch(/never twice/);
  });

  it("draws a branded graphic for a social slot it had no photo for, and refuses the second call", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const slot = f.planned.find((p) => p.channel === "facebook")!;
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_save_draft", { itemId: slot.id, body: "Fixed fares to Stansted, booked in advance.", imagePrompt: "A cab at the terminal" })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "content_render_image", { itemId: slot.id })], stopReason: "tool_use", usage },
        { content: [toolUse("t3", "content_render_image", { itemId: slot.id })], stopReason: "tool_use", usage },
        { content: [text("Drafted 1 slot with an image.")], stopReason: "end_turn", usage },
      ]);

      const result = await runAgent(writer(), {
        db, organisationId: f.orgId, trigger: "cron", payload: { clientId: f.clientId, periodKey: PERIOD },
        llm, policy: "safe", logger: quiet, now: () => NOW,
      });

      expect(result.status).toBe("completed");
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      const renders = steps
        .filter((s) => s.kind === "tool_result" && s.toolName === "content_render_image")
        .map((s) => s.output as { rendered: boolean; mode?: string; costPence?: number; reason?: string });
      // Template, because the client's brief has not opted in to AI — free,
      // and the second call costs nothing either: the slot already has one.
      expect(renders[0]).toMatchObject({ rendered: true, mode: "template", costPence: 0 });
      expect(renders[1]).toMatchObject({ rendered: false, reason: "already_has_image" });
      expect(imagegen.calls).toHaveLength(0);

      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, slot.id));
      expect(item!.imageUrl).toMatch(/\/api\/assets\//);
    });
  });

  it("drafts every unfilled slot and sends each one for approval in one run, then completes", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const byChannel = (channel: string) => f.planned.find((p) => p.channel === channel)!.id;
      const agent = writer();

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_get_brief", { clientId: f.clientId })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "knowledge_search", { query: "airport transfers", limit: 5 })], stopReason: "tool_use", usage },
        { content: [toolUse("t3", "content_list_slots", { clientId: f.clientId, periodKey: PERIOD })], stopReason: "tool_use", usage },
        {
          content: [
            toolUse("t4", "content_save_draft", { itemId: byChannel("facebook"), body: "Fixed fares to Stansted, booked in advance.", imagePrompt: "A cab at the terminal" }),
            toolUse("t5", "content_save_draft", { itemId: byChannel("instagram"), body: "Early flight? We are up before you are.", imagePrompt: "Dawn over Grays" }),
            toolUse("t6", "content_save_draft", { itemId: byChannel("blog"), title: "Getting to Stansted from Grays", body: "## The early start\n\nBook ahead.", imagePrompt: "Departures board" }),
            toolUse("t7", "content_save_draft", { itemId: byChannel("gbp"), body: "Airport transfers at fixed fares — book in advance.", linkUrl: "https://grayscabline.co.uk/airport" }),
          ],
          stopReason: "tool_use", usage,
        },
        {
          content: [
            toolUse("t8", "content_request_approval", { itemId: byChannel("facebook") }),
            toolUse("t9", "content_request_approval", { itemId: byChannel("instagram") }),
            toolUse("t10", "content_request_approval", { itemId: byChannel("blog") }),
            toolUse("t11", "content_request_approval", { itemId: byChannel("gbp") }),
          ],
          stopReason: "tool_use", usage,
        },
        { content: [text("Drafted 4 slots and sent all 4 for approval.")], stopReason: "end_turn", usage },
      ]);

      const result = await runAgent(agent, {
        db, organisationId: f.orgId, trigger: "cron", payload: { clientId: f.clientId, periodKey: PERIOD },
        llm, policy: "safe", logger: quiet, now: () => NOW,
      });

      // The whole month in one run: no parking, because the gate is the
      // content_publish card, not a kernel approval on the tool call.
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("4");

      const items = await db.select().from(schema.contentItems)
        .where(and(eq(schema.contentItems.organisationId, f.orgId), eq(schema.contentItems.periodKey, PERIOD)));
      expect(items).toHaveLength(4);
      expect(items.every((i) => i.status === "awaiting_approval" && i.approvalId !== null)).toBe(true);
      expect(items.find((i) => i.channel === "blog")!.title).toBe("Getting to Stansted from Grays");

      const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId));
      expect(approvals).toHaveLength(4);
      expect(approvals.every((a) => a.kind === "content_publish" && a.status === "pending" && a.runId === null)).toBe(true);
      // None of them is bound to the run: nothing in agent_runs is parked.
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.status).toBe("completed");
      expect((run!.metadata as { pending?: unknown }).pending).toBeUndefined();

      // Every write names the writer, so the trail says who drafted what.
      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, f.orgId), eq(schema.auditLog.action, "content_item.approval_requested")));
      expect(audits).toHaveLength(4);
      expect(audits.every((a) => a.actorKind === "agent" && a.actorId === CONTENT_WRITER_KEY)).toBe(true);

      // The trace holds every tool call and its result.
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      expect(steps.filter((s) => s.kind === "tool_result" && s.toolName === "content_save_draft")).toHaveLength(4);
      const brief = steps.find((s) => s.kind === "tool_result" && s.toolName === "content_get_brief")!.output as { brief: { tone: string } };
      expect(brief.brief.tone).toBe("Friendly, plain, local");
    });
  });

  it("approving the card is what publishes: the decision makes the slot approved and the sweep can claim it", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const slot = f.planned.find((p) => p.channel === "facebook")!;
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_save_draft", { itemId: slot.id, body: "Book ahead for the airport." })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "content_request_approval", { itemId: slot.id })], stopReason: "tool_use", usage },
        { content: [text("Drafted 1 slot and sent it for approval.")], stopReason: "end_turn", usage },
      ]);
      const result = await runAgent(writer(), {
        db, organisationId: f.orgId, trigger: "manual", payload: { clientId: f.clientId, periodKey: PERIOD },
        llm, policy: "safe", logger: quiet, now: () => NOW,
      });
      expect(result.status).toBe("completed");

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId));
      // Exactly what the admin approvals action does for a run-less content_publish card.
      await decideApproval(db, f.orgId, { approvalId: approval!.id, decision: "approved", decidedByUserId: f.ownerId });
      const applied = await applyContentPublishDecision(db, f.orgId, { approvalId: approval!.id, actorId: f.ownerId });
      expect(applied.item!.status).toBe("approved");

      // Nothing was published by approving; the publish sweep claims it when due.
      const claimed = await claimDueContent(db, f.orgId, { now: new Date("2026-10-01T00:00:00Z") });
      expect(claimed.map((c) => c.id)).toEqual([slot.id]);
      expect(claimed[0]!.status).toBe("publishing");
    });
  });

  it("parks every tool under approval_all, so the stricter policy still gates the writer", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const slot = f.planned.find((p) => p.channel === "facebook")!;
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_save_draft", { itemId: slot.id, body: "Book ahead." })], stopReason: "tool_use", usage },
      ]);
      const result = await runAgent(writer(), {
        db, organisationId: f.orgId, trigger: "manual", payload: { clientId: f.clientId, periodKey: PERIOD },
        llm, policy: "approval_all", logger: quiet, now: () => NOW,
      });
      expect(result.status).toBe("awaiting_approval");
      const items = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, slot.id));
      expect(items[0]!.body).toBeNull();
    });
  });

  it("does not stop the run when a save is refused: the refusal is a tool result the model can act on", async () => {
    await withTestDb(async (db) => {
      const f = await writerFixture(db);
      const blog = f.planned.find((p) => p.channel === "blog")!;
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "content_save_draft", { itemId: blog.id, body: "## No title yet" })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "content_save_draft", { itemId: blog.id, title: "Now titled", body: "## Better" })], stopReason: "tool_use", usage },
        { content: [text("Drafted 1 slot.")], stopReason: "end_turn", usage },
      ]);
      const result = await runAgent(writer(), {
        db, organisationId: f.orgId, trigger: "manual", payload: { clientId: f.clientId, periodKey: PERIOD },
        llm, policy: "safe", logger: quiet, now: () => NOW,
      });
      expect(result.status).toBe("completed");
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      const results = steps.filter((s) => s.kind === "tool_result" && s.toolName === "content_save_draft").map((s) => s.output as { saved: boolean });
      expect(results.map((r) => r.saved)).toEqual([false, true]);
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, blog.id));
      expect(item!.title).toBe("Now titled");
    });
  });
});
