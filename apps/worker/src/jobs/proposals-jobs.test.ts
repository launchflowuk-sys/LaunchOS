import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  acceptProposal,
  createLead,
  createProposal,
  decideApproval,
  getProposalDetail,
  requestProposalApproval,
  sendProposal,
  setEnqueue,
  type ProposalAcceptedJobData,
} from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import type { BossRegistrar } from "./content-jobs.js";
import {
  PROPOSAL_CRON,
  ensureProposalDrafterEnabled,
  installProposalFollowOn,
  registerProposalJobs,
  runProposalExpiry,
  runProposalNudges,
} from "./proposals-jobs.js";
import { followOnJobFor, handleProposalSend, runProposalSendSweep } from "./proposals-send.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-worker-proposals-"));
process.env["STORAGE_DIR"] = storage;
process.env["APP_URL"] = "https://os.launchflow.test";

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-07T10:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

function fakeBoss() {
  const work = vi.fn<(queue: string, handler: unknown) => Promise<string>>().mockResolvedValue("worker-id");
  const schedule = vi.fn<(queue: string, cron: string, data: unknown, options: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const send = vi.fn<(queue: string, data: unknown, options?: unknown) => Promise<string>>().mockResolvedValue("job-id");
  return { boss: { work, schedule, send } as unknown as BossRegistrar, work, schedule, send };
}

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `pw-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });
  const lead = await createLead(db, organisationId, {
    name: "Aisha Khan", business: "Khan Dental", email: "aisha@khandental.test", source: "website",
    notifyOwner: false, acknowledge: false,
  });
  return { organisationId, ownerId, leadId: lead.id };
}

async function draft(db: Db, organisationId: string, leadId: string, ownerId: string) {
  return createProposal(db, organisationId, {
    leadId,
    title: "Website for Khan Dental",
    pricing: { shape: "one_off" },
    scope: { deliverables: ["Six-page website"], outOfScope: [], timeline: "Four working weeks." },
    lines: [{ kind: "one_off", description: "Design and build", unitPence: 95_000 }],
    actorId: ownerId,
    now: NOW,
  });
}

describe("the proposal queues", () => {
  it("registers a worker for each of the four queues and puts the three crons on London time", async () => {
    await withTestDb(async (db) => {
      const { boss, work, schedule } = fakeBoss();
      await registerProposalJobs({ db, boss, payments: new MockPaymentsAdapter(), env: process.env, logger: quiet });
      expect(work.mock.calls.map(([queue]) => queue).sort()).toEqual([
        "proposals.accepted", "proposals.expire", "proposals.nudge", "proposals.send",
      ]);
      expect(schedule.mock.calls.map(([queue, cron, , options]) => [queue, cron, options])).toEqual([
        ["proposals.send", "*/2 * * * *", { tz: "Europe/London" }],
        ["proposals.expire", "30 6 * * *", { tz: "Europe/London" }],
        ["proposals.nudge", "0 9 * * *", { tz: "Europe/London" }],
      ]);
      // 06:30 before Shoji reads anything; 09:00 with the morning's bells.
      expect(PROPOSAL_CRON["proposals.expire"]).toBe("30 6 * * *");
      expect(PROPOSAL_CRON["proposals.nudge"]).toBe("0 9 * * *");
    });
  });

  it("turns core's no-op follow-on hook into a keyed send, so an acceptance actually reaches the worker", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss, send } = fakeBoss();
      installProposalFollowOn(boss);

      const proposal = await draft(db, f.organisationId, f.leadId, f.ownerId);
      await sendProposal(db, f.organisationId, { proposalId: proposal.proposal.id, actorKind: "user", actorId: f.ownerId, now: NOW });
      const after = (await getProposalDetail(db, f.organisationId, proposal.proposal.id))!;
      await acceptProposal(db, f.organisationId, {
        token: after.proposal.publicToken, acceptedName: "Aisha Khan", acceptedEmail: "aisha@khandental.test", now: NOW,
      });

      expect(send).toHaveBeenCalledTimes(1);
      const [queue, job, options] = send.mock.calls[0]! as unknown as [string, ProposalAcceptedJobData, { singletonKey: string }];
      expect(queue).toBe("proposals.accepted");
      expect(job).toMatchObject({
        organisationId: f.organisationId, proposalId: proposal.proposal.id,
        shape: "one_off", dueOnAcceptancePence: 95_000, recurringMonthlyPence: 0,
      });
      expect(options).toEqual({ singletonKey: `proposal-accepted:${proposal.proposal.id}` });
      // The stamp is what stops the sweep re-queueing it.
      const stamped = (await getProposalDetail(db, f.organisationId, proposal.proposal.id))!;
      expect(stamped.proposal.metadata["followOnQueuedAt"]).toEqual(expect.any(String));
    });
  });

  it("enables the drafter once per organisation and never overrides a decision", async () => {
    await withTestDb(async (db) => {
      const a = await fixture(db);
      const b = await fixture(db);
      await db.insert(schema.agentEnablement).values({ organisationId: b.organisationId, agentKey: "proposal-drafter", enabled: false });
      expect((await ensureProposalDrafterEnabled(db, quiet)).enabled).toBeGreaterThanOrEqual(1);
      expect((await ensureProposalDrafterEnabled(db, quiet)).enabled).toBe(0);
      const rows = await db.select().from(schema.agentEnablement).where(eq(schema.agentEnablement.agentKey, "proposal-drafter"));
      expect(rows.find((r) => r.organisationId === a.organisationId)?.enabled).toBe(true);
      expect(rows.find((r) => r.organisationId === b.organisationId)?.enabled).toBe(false);
    });
  });
});

describe("proposals.send", () => {
  it("sends the proposal an approved card asked for, and stamps the approval so nothing sends it twice", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const proposal = await draft(db, f.organisationId, f.leadId, f.ownerId);
      const { approval } = await requestProposalApproval(db, f.organisationId, {
        proposalId: proposal.proposal.id, actorKind: "agent", actorId: "proposal-drafter", now: NOW,
      });
      await decideApproval(db, f.organisationId, { approvalId: approval.id, decision: "approved", decidedByUserId: f.ownerId });

      const first = await handleProposalSend({ db, logger: quiet }, {
        organisationId: f.organisationId, approvalId: approval.id, actorId: f.ownerId,
      });
      expect(first).toMatchObject({ sent: true, proposalId: proposal.proposal.id });
      const after = (await getProposalDetail(db, f.organisationId, proposal.proposal.id))!;
      expect(after.proposal.status).toBe("sent");
      expect(after.proposal.documentId).not.toBeNull();

      // The retry pg-boss would make finds the stamp and does nothing.
      const second = await handleProposalSend({ db, logger: quiet }, {
        organisationId: f.organisationId, approvalId: approval.id, actorId: f.ownerId,
      });
      expect(second).toMatchObject({ sent: false, reason: "already applied" });
      const sentNotices = await db.select().from(schema.messages)
        .where(and(eq(schema.messages.organisationId, f.organisationId), eq(schema.messages.toEmail, "aisha@khandental.test")));
      expect(sentNotices).toHaveLength(1);
    });
  });

  it("leaves a rejected card's draft exactly as it was", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const proposal = await draft(db, f.organisationId, f.leadId, f.ownerId);
      const { approval } = await requestProposalApproval(db, f.organisationId, {
        proposalId: proposal.proposal.id, actorKind: "agent", actorId: "proposal-drafter", now: NOW,
      });
      await decideApproval(db, f.organisationId, { approvalId: approval.id, decision: "rejected", decidedByUserId: f.ownerId, note: "Too cheap." });

      const result = await handleProposalSend({ db, logger: quiet }, { organisationId: f.organisationId, approvalId: approval.id });
      expect(result).toMatchObject({ sent: false });
      const after = (await getProposalDetail(db, f.organisationId, proposal.proposal.id))!;
      expect(after.proposal.status).toBe("draft");
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId))).toEqual([]);
    });
  });

  it("answers a refusal as data rather than failing the job, so pg-boss does not retry a settled question", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const proposal = await draft(db, f.organisationId, f.leadId, f.ownerId);
      await sendProposal(db, f.organisationId, { proposalId: proposal.proposal.id, actorKind: "user", actorId: f.ownerId, now: NOW });
      const result = await handleProposalSend({ db, logger: quiet }, {
        organisationId: f.organisationId, proposalId: proposal.proposal.id, actorId: f.ownerId,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toMatch(/already been sent/i);
    });
  });

  it("sweeps up a decision whose job was lost and an acceptance whose follow-on never got away", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss, send } = fakeBoss();

      // A decided card nobody carried out.
      const stranded = await draft(db, f.organisationId, f.leadId, f.ownerId);
      const { approval } = await requestProposalApproval(db, f.organisationId, {
        proposalId: stranded.proposal.id, actorKind: "agent", actorId: "proposal-drafter", now: NOW,
      });
      await decideApproval(db, f.organisationId, { approvalId: approval.id, decision: "approved", decidedByUserId: f.ownerId });

      // An acceptance whose follow-on the queue swallowed: the hook throws, so
      // `followOnQueuedAt` is never stamped and the sweep is the only way back.
      await sendProposal(db, f.organisationId, { proposalId: stranded.proposal.id, actorKind: "user", actorId: f.ownerId, now: NOW });

      const totals = await runProposalSendSweep({ db, boss, logger: quiet });
      expect(totals.applied).toBe(1);
      const afterSweep = (await getProposalDetail(db, f.organisationId, stranded.proposal.id))!;
      expect(afterSweep.proposal.status).toBe("sent");

      // Now accept it with no follow-on installed and let the sweep find it.
      await acceptProposal(db, f.organisationId, {
        token: afterSweep.proposal.publicToken, acceptedName: "Aisha Khan", acceptedEmail: "aisha@khandental.test", now: NOW,
      });
      await db.update(schema.proposals).set({ metadata: {} })
        .where(eq(schema.proposals.id, stranded.proposal.id));
      send.mockClear();
      const second = await runProposalSendSweep({ db, boss, logger: quiet });
      expect(second.followOnRequeued).toBe(1);
      expect(send).toHaveBeenCalledWith(
        "proposals.accepted",
        expect.objectContaining({ proposalId: stranded.proposal.id, dueOnAcceptancePence: 95_000 }),
        { singletonKey: `proposal-accepted:${stranded.proposal.id}` },
      );
      expect(await followOnJobFor(db, f.organisationId, randomUUID())).toBeNull();
    });
  });
});

describe("the daily sweeps", () => {
  it("expires a proposal only once the London day it was valid until is over", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const proposal = await createProposal(db, f.organisationId, {
        leadId: f.leadId, title: "Short-dated", pricing: { shape: "one_off" },
        lines: [{ kind: "one_off", description: "Build", unitPence: 50_000 }],
        validUntil: "2026-09-30", actorId: f.ownerId, now: NOW,
      });
      await sendProposal(db, f.organisationId, { proposalId: proposal.proposal.id, actorKind: "user", actorId: f.ownerId, now: NOW });

      // 22:30 UTC on 30 September is 23:30 in London — still in time.
      expect((await runProposalExpiry({ db, logger: quiet }, new Date("2026-09-30T22:30:00Z"))).expired).toBe(0);
      // 23:30 UTC is 00:30 on 1 October in London — out of time.
      expect((await runProposalExpiry({ db, logger: quiet }, new Date("2026-09-30T23:30:00Z"))).expired).toBe(1);
      const after = (await getProposalDetail(db, f.organisationId, proposal.proposal.id))!;
      expect(after.proposal.status).toBe("expired");
    });
  });

  it("rings the owner about an unopened proposal once, and emails the client nothing at all", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const proposal = await draft(db, f.organisationId, f.leadId, f.ownerId);
      await sendProposal(db, f.organisationId, { proposalId: proposal.proposal.id, actorKind: "user", actorId: f.ownerId, now: NOW });
      const messagesBefore = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId));

      const fourDaysOn = new Date(NOW.getTime() + 4 * 86_400_000);
      expect((await runProposalNudges({ db, logger: quiet }, fourDaysOn)).nudged).toBe(1);
      expect((await runProposalNudges({ db, logger: quiet }, fourDaysOn)).nudged).toBe(0);

      const bells = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.organisationId, f.organisationId), eq(schema.notifications.kind, "proposal.unopened")));
      expect(bells).toHaveLength(1);
      // Chasing is Shoji's call: not one extra email left the building.
      const messagesAfter = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId));
      expect(messagesAfter).toHaveLength(messagesBefore.length);
    });
  });
});
