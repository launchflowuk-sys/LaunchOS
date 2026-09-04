import { describe, expect, it, vi } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createClient, createSite, createTicket, ensureEmailIdentity, ingestInboundEmail, openIncident } from "@launchos/core";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { dispatchEvent, type BossSender } from "./dispatch-event.js";

function fakeBoss() {
  const send = vi.fn(async () => "job-id");
  return { send } as unknown as BossSender;
}

describe("dispatchEvent", () => {
  it("routes client.created to tasks.generate-onboarding and also ensures an email identity", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });

      await dispatchEvent({ db, boss }, { name: "client.created", organisationId: org!.id, clientId: client.id });

      expect(boss.send).toHaveBeenCalledWith(
        "tasks.generate-onboarding",
        { organisationId: org!.id, clientId: client.id },
        { singletonKey: `onboarding:${client.id}` },
      );
      const [identity] = await db.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.clientId, client.id));
      expect(identity).toBeDefined();
    });
  });

  it("still routes incident.opened to agent.run for the guard-dog agent", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      const incident = await openIncident(db, org!.id, { siteId: site.id, title: "S down", severity: "critical" });

      await dispatchEvent({ db, boss }, { name: "incident.opened", organisationId: org!.id, incidentId: incident.id });

      expect(boss.send).toHaveBeenCalledWith(
        "agent.run",
        expect.objectContaining({ agentKey: "hosting-guard-dog", organisationId: org!.id }),
        { singletonKey: `guard-dog:${incident.id}` },
      );
    });
  });

  it("routes ticket.created to agent.run for support-triage", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const { ticket } = await createTicket(db, org!.id, {
        clientId: client.id, subject: "Help", body: "Broken", source: "manual", severity: "medium",
        actorKind: "user", actorId: "u1",
      });

      await dispatchEvent({ db, boss }, { name: "ticket.created", organisationId: org!.id, ticketId: ticket.id });

      expect(boss.send).toHaveBeenCalledWith(
        "agent.run",
        expect.objectContaining({ agentKey: "support-triage", organisationId: org!.id }),
        { singletonKey: `support-triage:${ticket.id}` },
      );
    });
  });

  it("routes email.received to inbound.message keyed by the provider Message-ID", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client.id });
      const inbound = {
        provider: "generic" as const, to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
        messageId: "<d-1@client.test>", references: [], attachments: [], rawHeaders: {},
      };

      await dispatchEvent({ db, boss }, { name: "email.received", organisationId: org!.id, inbound });

      expect(boss.send).toHaveBeenCalledWith(
        "inbound.message",
        { organisationId: org!.id, inbound },
        { singletonKey: `inbound:${inbound.messageId}` },
      );
    });
  });

  it("routes message.queued to outbound.message keyed by the message id", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client.id });
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
        messageId: "<d-2@client.test>", references: [], attachments: [], rawHeaders: {},
      });

      await dispatchEvent({ db, boss }, { name: "message.queued", organisationId: org!.id, messageId: ingested.message.id });

      expect(boss.send).toHaveBeenCalledWith(
        "outbound.message",
        { organisationId: org!.id, messageId: ingested.message.id },
        { singletonKey: `outbound:${ingested.message.id}` },
      );
    });
  });

  it("routes approval.decided to agent.resume keyed by the approval id", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const organisationId = randomUUID();
      const runId = randomUUID();
      const approvalId = randomUUID();

      await dispatchEvent(
        { db, boss },
        { name: "approval.decided", organisationId, runId, approvalId, decision: "approved" },
      );

      expect(boss.send).toHaveBeenCalledWith(
        "agent.resume",
        { organisationId, runId, approvalId, decision: "approved" },
        { singletonKey: `resume:${approvalId}` },
      );
    });
  });

  it("routes payments.webhook to payments.webhook keyed by the provider event id", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const organisationId = randomUUID();
      const providerEvent = { id: "evt_1", type: "invoice.paid", data: {} };

      await dispatchEvent({ db, boss }, { name: "payments.webhook", organisationId, providerEvent });

      expect(boss.send).toHaveBeenCalledWith(
        "payments.webhook",
        { organisationId, providerEvent },
        { singletonKey: `stripe:${providerEvent.id}`, singletonSeconds: 86_400 },
      );
    });
  });
});
