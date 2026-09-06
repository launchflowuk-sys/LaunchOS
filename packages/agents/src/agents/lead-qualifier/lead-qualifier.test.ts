import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { applyLeadReplyDecision, createKnowledgeArticle, createLead, decideApproval } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { Db } from "@launchos/db";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { LEAD_QUALIFIER_KEY, leadQualifier } from "./index.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const quiet = { info() {}, warn() {}, error() {} };
const env = { APP_URL: "https://os.launchflow.test" } as NodeJS.ProcessEnv;

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `lq-${randomUUID()}` }).returning();
  const orgId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: ownerId, role: "owner", status: "active" });
  await db.insert(schema.packages).values([
    { organisationId: orgId, name: "Starter", slug: "starter", monthlyPricePence: 9900, includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 } },
    { organisationId: orgId, name: "Retired", slug: "retired", monthlyPricePence: 100, active: false },
  ]);
  await createKnowledgeArticle(db, orgId, { title: "What we build", bodyMd: "Fast, hosted business websites with SEO and a support desk.", tags: ["sales"], published: true });
  const lead = await createLead(db, orgId, {
    name: "Aisha Khan", email: "aisha@example.test", business: "Khan Dental", message: "How much for a five-page site for my dental practice?",
    source: "website", attribution: { utmSource: "google", utmCampaign: "dentists" },
  }, env);
  return { orgId, ownerId, lead };
}

describe("lead-qualifier", () => {
  it("carries the four tools, every one safe to the kernel, on the lead.created trigger", () => {
    const agent = leadQualifier();
    expect(agent.key).toBe(LEAD_QUALIFIER_KEY);
    expect(agent.trigger).toEqual({ kind: "event", event: "lead.created" });
    expect(agent.tools.map((t) => t.name)).toEqual(["lead_get", "packages_list", "knowledge_search", "lead_draft_reply"]);
    expect(agent.tools.every((t) => t.risk === "safe")).toBe(true);
    expect(agent.systemPrompt).toMatch(/at most 120 words/);
    expect(agent.systemPrompt).toMatch(/Never promise a price for custom work/);
    expect(agent.systemPrompt).toMatch(/Do not write the booking link/);
  });

  it("reads the lead, the packages and the knowledge base, then raises one run-less lead_reply card and completes; approving sends", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "lead_get", { leadId: f.lead.id })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "packages_list", {}), toolUse("t3", "knowledge_search", { query: "dental practice website", limit: 5 })], stopReason: "tool_use", usage },
        {
          content: [toolUse("t4", "lead_draft_reply", {
            leadId: f.lead.id, subject: "Your website for Khan Dental",
            body: "Hi Aisha, thanks for asking about a five-page site for Khan Dental. Two quick questions: do you have a site today, and when would you like to launch? Most practices start on Starter at £99 a month; anything custom I price after a quick chat. Shoji",
            suggestedPackageSlug: "starter", questions: ["Do you have a site today?", "When would you like to launch?"],
          })],
          stopReason: "tool_use", usage,
        },
        { content: [text("Drafted a reply suggesting Starter; two questions about their current site and timeline.")], stopReason: "end_turn", usage },
      ]);
      const result = await runAgent(leadQualifier(), {
        db, organisationId: f.orgId, trigger: "event", payload: { leadId: f.lead.id }, llm, policy: "safe", logger: quiet,
      });
      expect(result.status).toBe("completed");

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      const got = steps.find((s) => s.kind === "tool_result" && s.toolName === "lead_get")!.output as { lead: { business: string }; attribution: { utmCampaign: string }; bookingUrl: string; thread: { kind: string }[] };
      expect(got.lead.business).toBe("Khan Dental");
      expect(got.attribution.utmCampaign).toBe("dentists");
      // The tool reads `process.env` for the link, so only the path is asserted here.
      expect(got.bookingUrl).toMatch(/\/book\?lead=[A-Za-z0-9_-]{32}$/);
      expect(got.thread.map((m) => m.kind)).toEqual(["lead_acknowledgement"]);
      const pkgs = steps.find((s) => s.kind === "tool_result" && s.toolName === "packages_list")!.output as { packages: { slug: string; monthlyPrice: string }[] };
      expect(pkgs.packages).toEqual([expect.objectContaining({ slug: "starter", monthlyPrice: "£99/month" })]);
      const drafted = steps.find((s) => s.kind === "tool_result" && s.toolName === "lead_draft_reply")!.output as { drafted: boolean; approvalId: string };
      expect(drafted.drafted).toBe(true);

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId));
      expect(approval).toMatchObject({ kind: "lead_reply", status: "pending", runId: null, id: drafted.approvalId });
      expect(approval!.payload).toMatchObject({ suggestedPackageName: "Starter", suggestedPackageMonthlyPence: 9900, requestedById: LEAD_QUALIFIER_KEY });
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.status).toBe("completed");

      // Nothing left the building: only the acknowledgement is queued so far.
      const before = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.orgId));
      expect(before.map((m) => m.metadata["kind"])).toEqual(["lead_acknowledgement"]);

      await decideApproval(db, f.orgId, { approvalId: approval!.id, decision: "approved", decidedByUserId: f.ownerId });
      const applied = await applyLeadReplyDecision(db, f.orgId, { approvalId: approval!.id, actorId: f.ownerId }, env);
      expect(applied.message!.body).toContain("Starter at £99 a month");
      expect(applied.message!.body).toMatch(/https:\/\/os\.launchflow\.test\/book\?lead=/);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, f.lead.id));
      expect(lead!.status).toBe("contacted");
    });
  });

  it("returns refusals as data: an over-long body, a second draft while one is pending, an unknown lead", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const long = Array.from({ length: 170 }, () => "word").join(" ");
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "lead_draft_reply", { leadId: f.lead.id, subject: "s", body: long, questions: ["q"] })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "lead_draft_reply", { leadId: f.lead.id, subject: "s", body: "Short.", questions: ["q"] })], stopReason: "tool_use", usage },
        { content: [toolUse("t3", "lead_draft_reply", { leadId: f.lead.id, subject: "s", body: "Again.", questions: ["q"] })], stopReason: "tool_use", usage },
        { content: [toolUse("t4", "lead_get", { leadId: randomUUID() })], stopReason: "tool_use", usage },
        { content: [text("Done.")], stopReason: "end_turn", usage },
      ]);
      const result = await runAgent(leadQualifier(), { db, organisationId: f.orgId, trigger: "event", payload: { leadId: f.lead.id }, llm, policy: "safe", logger: quiet });
      expect(result.status).toBe("completed");
      const outputs = (await db.select().from(schema.agentSteps).where(and(eq(schema.agentSteps.runId, result.runId), eq(schema.agentSteps.kind, "tool_result"))))
        .map((s) => s.output as Record<string, unknown>);
      expect(outputs[0]).toMatchObject({ drafted: false, reason: expect.stringMatching(/170 words/) });
      expect(outputs[1]).toMatchObject({ drafted: true });
      expect(outputs[2]).toMatchObject({ drafted: false, reason: expect.stringMatching(/already waiting/) });
      expect(outputs[3]).toEqual({ found: false, leadId: expect.any(String) });
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId))).toHaveLength(1);
    });
  });

  it("parks on the card under approval_all, and lead_get never crosses organisations", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const other = await fixture(db);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "lead_get", { leadId: other.lead.id })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "lead_draft_reply", { leadId: f.lead.id, subject: "s", body: "Short.", questions: ["q"] })], stopReason: "tool_use", usage },
      ]);
      const result = await runAgent(leadQualifier(), { db, organisationId: f.orgId, trigger: "event", payload: { leadId: f.lead.id }, llm, policy: "approval_all", logger: quiet });
      expect(result.status).toBe("awaiting_approval");
      const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId));
      expect(approvals.map((a) => a.kind)).toEqual(["tool_call"]);
    });
  });
});
