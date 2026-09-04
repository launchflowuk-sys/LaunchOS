import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { createKnowledgeArticle, ensureEmailIdentity, ingestInboundEmail, sendQueuedMessage } from "@launchos/core";
import { MockCloudflareDns, MockCmsProvider, MockHostingProvider, MockUptimeProbe } from "@launchos/integrations";
import type { AgentIntegrations } from "../integrations.js";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { resumeAgent } from "../../kernel/resume-agent.js";
import { runAgent } from "../../kernel/run-agent.js";
import { supportTriage } from "./index.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

const integrations: AgentIntegrations = {
  uptime: new MockUptimeProbe(),
  hosting: new MockHostingProvider(),
  dns: new MockCloudflareDns(),
  cms: new MockCmsProvider(),
};

const usage = { inputTokens: 1, outputTokens: 1 };

async function member(db: Db, organisationId: string, role: "owner" | "staff") {
  const [row] = await db
    .insert(schema.user)
    .values({ id: crypto.randomUUID(), name: role, email: `${role}-${crypto.randomUUID()}@launchflow.test` })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId, userId: row!.id, role, status: "active" });
  return row!;
}

/** An organisation with a client, its support address, one KB article and an inbound email that opened a ticket. */
async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${crypto.randomUUID()}` })
    .returning();
  const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
  await createKnowledgeArticle(db, org!.id, {
    title: "DNS propagation",
    bodyMd: "Nameserver changes take up to 48 hours to propagate worldwide.",
    tags: ["dns"],
    published: true,
  });
  const ingested = await ingestInboundEmail(db, org!.id, {
    provider: "generic",
    to: [identity.address],
    from: "jo@grayscabline.co.uk",
    subject: "Website not loading since the nameserver change",
    text: "We changed nameservers yesterday and the site will not load.",
    messageId: `<jo-${crypto.randomUUID()}@grayscabline.co.uk>`,
    references: [],
    attachments: [],
    rawHeaders: {},
  });
  const owner = await member(db, org!.id, "owner");
  const staff = await member(db, org!.id, "staff");
  return {
    organisationId: org!.id,
    clientId: client!.id,
    owner,
    staff,
    ticketId: ingested.ticket.id,
    conversationId: ingested.conversation.id,
  };
}

describe("support-triage", () => {
  it("classifies a ticket, cites the knowledge base, assigns it, parks a reply, and sends it on approval", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const agent = supportTriage(integrations);
      const draft =
        "Hi Jo, nameserver changes can take up to 48 hours to propagate. We are watching it and will confirm once it resolves.";

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "tickets_get", { ticketId: f.ticketId })], stopReason: "tool_use", usage },
        {
          content: [toolUse("t2", "knowledge_search", { query: "nameserver propagation", limit: 3 })],
          stopReason: "tool_use",
          usage,
        },
        {
          content: [
            toolUse("t3", "tickets_update", {
              ticketId: f.ticketId,
              category: "dns",
              severity: "high",
              status: "triaged",
              triage: {
                category: "dns",
                severity: "high",
                summary: "Nameserver change still propagating",
                suggestedFix: "Reassure and re-check in 24h",
                confidence: 0.78,
              },
            }),
            toolUse("t4", "tasks_create", {
              clientId: f.clientId,
              ticketId: f.ticketId,
              title: "Re-check grayscabline.co.uk nameserver propagation in 24h",
            }),
            toolUse("t5", "tickets_assign", { ticketId: f.ticketId }),
          ],
          stopReason: "tool_use",
          usage,
        },
        {
          content: [toolUse("t6", "messages_reply_to_client", { conversationId: f.conversationId, body: draft })],
          stopReason: "tool_use",
          usage,
        },
        { content: [text("Triaged as DNS, assigned, and a reply is awaiting approval.")], stopReason: "end_turn", usage },
      ]);

      const parked = await runAgent(agent, {
        db,
        organisationId: f.organisationId,
        trigger: "event",
        payload: { ticketId: f.ticketId, clientId: f.clientId, conversationId: f.conversationId },
        llm,
        policy: "safe",
        logger: console,
      });

      expect(parked.status).toBe("awaiting_approval");
      const [triaged] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticketId));
      expect(triaged!.status).toBe("triaged");
      expect(triaged!.category).toBe("dns");
      expect(triaged!.severity).toBe("high");
      expect(triaged!.assignedUserId).toBe(f.staff.id);
      expect(triaged!.triage).toMatchObject({ category: "dns", confidence: 0.78 });

      const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.ticketId, f.ticketId));
      expect(task!.phase).toBe("support");
      expect(task!.clientVisible).toBe(false);

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, parked.runId));
      expect(approval!.status).toBe("pending");
      expect(approval!.payload).toMatchObject({
        toolName: "messages_reply_to_client",
        toolUseId: "t6",
        input: { conversationId: f.conversationId, body: draft },
      });
      // Nothing leaves the building before a human decides.
      expect(await db.select().from(schema.messages).where(eq(schema.messages.direction, "outbound"))).toHaveLength(0);

      // Shoji approves in the admin portal…
      const resumed = await resumeAgent(agent, {
        db,
        organisationId: f.organisationId,
        runId: parked.runId,
        approvalId: approval!.id,
        decision: "approved",
        decidedByUserId: f.owner.id,
        llm,
        policy: "safe",
        logger: console,
      });
      expect(resumed.status).toBe("completed");
      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval!.id));
      expect(decided!.status).toBe("approved");

      const [outbound] = await db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, f.conversationId), eq(schema.messages.direction, "outbound")))
        .orderBy(asc(schema.messages.createdAt));
      expect(outbound!.status).toBe("queued");
      expect(outbound!.body).toBe(draft);
      expect(outbound!.authorKind).toBe("agent");

      // …and the worker's outbound.message job sends it.
      const adapter = new MockEmailAdapter();
      const sent = await sendQueuedMessage(db, f.organisationId, { messageId: outbound!.id }, adapter, ENV);
      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.to).toBe("jo@grayscabline.co.uk");
      expect(adapter.sent[0]!.text).toBe(draft);
    });
  });

  it("sends nothing when the human rejects the drafted reply", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const agent = supportTriage(integrations);

      const llm = new FakeLlmClient([
        {
          content: [
            toolUse("t1", "messages_reply_to_client", { conversationId: f.conversationId, body: "Draft nobody approved." }),
          ],
          stopReason: "tool_use",
          usage,
        },
        { content: [text("The reply was rejected, so I left the ticket for a human.")], stopReason: "end_turn", usage },
      ]);

      const parked = await runAgent(agent, {
        db,
        organisationId: f.organisationId,
        trigger: "event",
        payload: { ticketId: f.ticketId, clientId: f.clientId, conversationId: f.conversationId },
        llm,
        policy: "safe",
        logger: console,
      });
      expect(parked.status).toBe("awaiting_approval");

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, parked.runId));
      const resumed = await resumeAgent(agent, {
        db,
        organisationId: f.organisationId,
        runId: parked.runId,
        approvalId: approval!.id,
        decision: "rejected",
        note: "Wrong answer — the zone is not delegated yet.",
        decidedByUserId: f.owner.id,
        llm,
        policy: "safe",
        logger: console,
      });
      expect(resumed.status).toBe("completed");

      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval!.id));
      expect(decided!.status).toBe("rejected");
      expect(decided!.decisionNote).toBe("Wrong answer — the zone is not delegated yet.");
      const outbound = await db.select().from(schema.messages).where(eq(schema.messages.direction, "outbound"));
      expect(outbound).toHaveLength(0);
    });
  });

  it("escalates to the owner instead of answering when it is out of its depth", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const agent = supportTriage(integrations);

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "tickets_get", { ticketId: f.ticketId })], stopReason: "tool_use", usage },
        {
          content: [
            toolUse("t2", "tickets_update", {
              ticketId: f.ticketId,
              category: "dns",
              severity: "critical",
              status: "triaged",
              triage: {
                category: "dns",
                severity: "critical",
                summary: "Site offline and the client is threatening to leave",
                suggestedFix: "Shoji to call the client",
                confidence: 0.2,
              },
            }),
            toolUse("t3", "tickets_escalate", {
              ticketId: f.ticketId,
              reason: "The site is offline and the client is threatening to leave.",
            }),
          ],
          stopReason: "tool_use",
          usage,
        },
        { content: [text("Escalated to Shoji: critical outage with a client at risk.")], stopReason: "end_turn", usage },
      ]);

      const result = await runAgent(agent, {
        db,
        organisationId: f.organisationId,
        trigger: "event",
        payload: { ticketId: f.ticketId, clientId: f.clientId, conversationId: f.conversationId },
        llm,
        policy: "safe",
        logger: console,
      });
      expect(result.status).toBe("completed");

      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticketId));
      expect(ticket!.escalated).toBe(true);
      expect(ticket!.severity).toBe("critical");
      expect(ticket!.escalationReason).toBe("The site is offline and the client is threatening to leave.");

      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, f.owner.id), eq(schema.notifications.kind, "support.escalated")));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.body).toBe("The site is offline and the client is threatening to leave.");

      // Escalation is not a reply: nothing was drafted to the client.
      expect(await db.select().from(schema.messages).where(eq(schema.messages.direction, "outbound"))).toHaveLength(0);
    });
  });
});
