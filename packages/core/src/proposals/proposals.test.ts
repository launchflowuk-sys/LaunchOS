import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "../events/emit.js";
import { createLead } from "../leads/leads.js";
import { PROPOSAL_NOTICE_KIND } from "../support/courtesy-notice.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { acceptProposal } from "./accept.js";
import { createProposal, getProposalDetail, getPublicProposal, listProposals, updateProposal } from "./crud.js";
import { setProposalFollowOn, type ProposalAcceptedJobData } from "./follow-on.js";
import { addProposalLine, removeProposalLine, updateProposalLine } from "./lines.js";
import { declineProposal, recordProposalView } from "./public.js";
import { sendProposal } from "./send.js";
import { ProposalRefused, getProposalAcceptance, proposalExpiresAt } from "./shared.js";
import { expireProposals, nudgeUnopenedProposals, proposalsAwaitingFollowOn } from "./sweeps.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-proposals-"));
const ENV = {
  STORAGE_DIR: storage,
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  APP_URL: "https://os.launchflow.test",
  SUPPORT_CONTACT_EMAIL: "hello@launchflow.test",
} as NodeJS.ProcessEnv;

/** Monday 7 September 2026, 10:00 UTC. */
const NOW = new Date("2026-09-07T10:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

/** Captures whatever `acceptProposal` hands to the queue, for the length of one call. */
function catchFollowOn() {
  const jobs: ProposalAcceptedJobData[] = [];
  setProposalFollowOn(async (job) => {
    jobs.push(job);
  });
  return jobs;
}

async function leadFixture(db: Db) {
  const seeded = await seedOrgWithClient(db);
  const lead = await createLead(db, seeded.organisationId, {
    name: "Aisha Khan", email: "aisha@example.test", business: "Khan Dental", source: "website",
  }, ENV);
  return { ...seeded, leadId: lead.id };
}

async function notices(db: Db, organisationId: string) {
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, organisationId));
  return rows
    .filter((m) => m.metadata["kind"] === PROPOSAL_NOTICE_KIND)
    .map((m) => ({ notice: m.metadata["notice"], to: m.toEmail, subject: m.subject, body: m.body, metadata: m.metadata }));
}

const MONTHLY = { shape: "monthly_on_delivery" as const };

describe("drafting a proposal", () => {
  it("mints a reference and a token, derives the price from the lines, and records it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const drafted = await createProposal(db, organisationId, {
        leadId,
        title: "Website and care plan",
        summary: "A new site, then looked after every month.",
        scope: { deliverables: ["Five-page website", "Hosting and backups"], outOfScope: ["Paid ads"], timeline: "Live in three weeks." },
        pricing: { shape: "setup_plus_monthly", vatNote: "No VAT is charged." },
        lines: [
          { kind: "setup", description: "Design and build", unitPence: 120_000 },
          { kind: "monthly", description: "Care plan", unitPence: 15_000 },
          { kind: "monthly", description: "SEO", unitPence: 10_000 },
        ],
        actorId: ownerUserId,
        now: NOW,
      });

      expect(drafted.proposal).toMatchObject({
        reference: "P-2026-001", status: "draft", leadId, clientId: null, createdByUserId: ownerUserId,
        title: "Website and care plan", validUntil: "2026-10-07",
      });
      expect(drafted.proposal.publicToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(drafted.proposal.pricing).toEqual({
        shape: "setup_plus_monthly", setupPence: 120_000, monthlyPence: 25_000, oneOffPence: 0,
        currency: "GBP", vatNote: "No VAT is charged.",
      });
      expect(drafted.totals).toMatchObject({ dueOnAcceptancePence: 120_000, recurringMonthlyPence: 25_000, firstYearPence: 420_000 });
      expect(drafted.lines.map((l) => l.description)).toEqual(["Design and build", "Care plan", "SEO"]);
      expect(drafted.recipient).toEqual({ name: "Aisha Khan", email: "aisha@example.test" });

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.targetId, drafted.proposal.id), eq(schema.auditLog.action, "proposal.created")));
      expect(audits).toHaveLength(1);
      const [timeline] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.kind, "proposal.created"));
      expect(timeline!.title).toContain("P-2026-001");

      // The second proposal of the year takes the next number.
      const second = await createProposal(db, organisationId, { leadId, title: "Ads", pricing: MONTHLY, actorId: ownerUserId, now: NOW });
      expect(second.proposal.reference).toBe("P-2026-002");
      expect(await listProposals(db, organisationId, { leadId })).toHaveLength(2);
    });
  });

  it("needs a lead or a client, and refuses lines the shape cannot carry", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      await expect(createProposal(db, organisationId, { title: "Nowhere", pricing: MONTHLY, actorId: ownerUserId }))
        .rejects.toThrow(/needs a lead or a client/);
      await expect(createProposal(db, organisationId, {
        leadId, title: "Muddled", pricing: { shape: "one_off" },
        lines: [{ kind: "one_off", description: "Build", unitPence: 90_000 }, { kind: "monthly", description: "Care", unitPence: 15_000 }],
        actorId: ownerUserId,
      })).rejects.toThrow(/cannot carry monthly lines/);
    });
  });
});

describe("the priced schedule", () => {
  it("reprices the proposal on every line change, and refuses a kind the shape does not allow", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Care plan", pricing: MONTHLY, actorId: ownerUserId, now: NOW,
      });

      const added = await addProposalLine(db, organisationId, { proposalId: proposal.id, kind: "monthly", description: "Care plan", unitPence: 15_000, actorId: ownerUserId });
      expect(added.proposal.pricing.monthlyPence).toBe(15_000);
      expect(added.totals.firstYearPence).toBe(180_000);

      const changed = await updateProposalLine(db, organisationId, { proposalId: proposal.id, lineId: added.lines[0]!.id, unitPence: 20_000, actorId: ownerUserId });
      expect(changed.proposal.pricing.monthlyPence).toBe(20_000);

      const extra = await addProposalLine(db, organisationId, { proposalId: proposal.id, kind: "monthly", description: "SEO", quantity: 2, unitPence: 5_000, actorId: ownerUserId });
      expect(extra.proposal.pricing.monthlyPence).toBe(30_000);

      const removed = await removeProposalLine(db, organisationId, { proposalId: proposal.id, lineId: extra.lines[1]!.id, actorId: ownerUserId });
      expect(removed.lines).toHaveLength(1);
      expect(removed.proposal.pricing.monthlyPence).toBe(20_000);

      await expect(addProposalLine(db, organisationId, { proposalId: proposal.id, kind: "setup", description: "Build", unitPence: 1, actorId: ownerUserId }))
        .rejects.toThrow(ProposalRefused);
    });
  });

  it("refuses a shape change that would strand the lines already on the proposal", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Build", pricing: { shape: "setup_plus_monthly" },
        lines: [{ kind: "setup", description: "Build", unitPence: 90_000 }, { kind: "monthly", description: "Care", unitPence: 15_000 }],
        actorId: ownerUserId, now: NOW,
      });
      await expect(updateProposal(db, organisationId, { proposalId: proposal.id, pricing: { shape: "one_off" }, actorId: ownerUserId }))
        .rejects.toThrow(/remove them first/);
      // Dropping the offending lines first is the way through.
      const detail = (await getProposalDetail(db, organisationId, proposal.id))!;
      for (const line of detail.lines) await removeProposalLine(db, organisationId, { proposalId: proposal.id, lineId: line.id, actorId: ownerUserId });
      const moved = await updateProposal(db, organisationId, { proposalId: proposal.id, pricing: { shape: "one_off" }, actorId: ownerUserId });
      expect(moved.proposal.pricing).toMatchObject({ shape: "one_off", setupPence: 0, monthlyPence: 0, oneOffPence: 0 });
    });
  });
});

describe("sending", () => {
  it("renders the PDF, keeps it as a document, moves the lead on, and queues one email carrying both links", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Website and care plan", pricing: { shape: "setup_plus_monthly" },
        lines: [{ kind: "setup", description: "Build", unitPence: 120_000 }, { kind: "monthly", description: "Care", unitPence: 25_000 }],
        actorId: ownerUserId, now: NOW,
      });

      const sent = await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      expect(sent.proposal).toMatchObject({ status: "sent", documentId: sent.document.id });
      expect(sent.proposal.sentAt?.toISOString()).toBe(NOW.toISOString());
      expect(sent.document).toMatchObject({
        kind: "proposal", reference: "P-2026-001", subjectType: "proposal", subjectId: proposal.id, clientId: null, mime: "application/pdf",
      });
      expect(sent.document.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sent.documentUrl).toMatch(new RegExp(`^https://os\\.launchflow\\.test/api/documents/${sent.document.id}\\?t=v1\\.`));
      expect(sent.proposalUrl).toBe(`https://os.launchflow.test/p/${proposal.publicToken}`);

      const queued = await notices(db, organisationId);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ notice: "sent", to: "aisha@example.test", subject: "Your proposal from LaunchFlow: Website and care plan" });
      expect(queued[0]!.body).toContain(sent.proposalUrl);
      expect(queued[0]!.body).toContain(sent.documentUrl);
      expect(queued[0]!.body).toContain("£1,200.00 to start, then £250.00 a month.");
      expect(queued[0]!.body).toContain("7 October 2026");
      expect(queued[0]!.metadata).toMatchObject({ documentId: sent.document.id, proposalId: proposal.id });

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId));
      expect(lead!.status).toBe("contacted");

      // A sent proposal is frozen: no second send, no edits, no new lines.
      await expect(sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId }, undefined, ENV))
        .rejects.toThrow(/already been sent/);
      await expect(updateProposal(db, organisationId, { proposalId: proposal.id, title: "New title", actorId: ownerUserId }))
        .rejects.toThrow(/write a new one/);
      await expect(addProposalLine(db, organisationId, { proposalId: proposal.id, kind: "monthly", description: "More", unitPence: 1, actorId: ownerUserId }))
        .rejects.toThrow(/figures cannot change/);
    });
  });

  it("refuses to send with nobody to write to, nothing priced, or a date already gone", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const anonymous = await createLead(db, organisationId, { name: "No Email", source: "manual" }, ENV);

      const noPrice = await createProposal(db, organisationId, { leadId, title: "Empty", pricing: MONTHLY, actorId: ownerUserId, now: NOW });
      await expect(sendProposal(db, organisationId, { proposalId: noPrice.proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV))
        .rejects.toThrow(/nothing priced/);

      const noRecipient = await createProposal(db, organisationId, {
        leadId: anonymous.id, title: "Nobody", pricing: MONTHLY,
        lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }], actorId: ownerUserId, now: NOW,
      });
      await expect(sendProposal(db, organisationId, { proposalId: noRecipient.proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV))
        .rejects.toThrow(/no email address/);

      const stale = await createProposal(db, organisationId, {
        leadId, title: "Yesterday", pricing: MONTHLY, validUntil: "2026-09-01",
        lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }], actorId: ownerUserId, now: NOW,
      });
      await expect(sendProposal(db, organisationId, { proposalId: stale.proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV))
        .rejects.toThrow(/expire already/);
    });
  });
});

describe("the public page", () => {
  it("stamps the first view once, however many times it is opened, and rings the bell once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Care", pricing: MONTHLY, lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }],
        actorId: ownerUserId, now: NOW,
      });
      await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      const token = proposal.publicToken;

      const first = await recordProposalView(db, organisationId, { token, now: NOW });
      expect(first).toMatchObject({ firstView: true });
      expect(first!.proposal.status).toBe("viewed");
      expect(first!.proposal.firstViewedAt?.toISOString()).toBe(NOW.toISOString());

      const later = new Date(NOW.getTime() + 3_600_000);
      const second = await recordProposalView(db, organisationId, { token, now: later });
      expect(second).toMatchObject({ firstView: false });
      expect(second!.proposal.firstViewedAt?.toISOString()).toBe(NOW.toISOString());

      const bells = await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.kind, "proposal.viewed")));
      expect(bells).toHaveLength(1);

      // Junk and unknown tokens are nothing, not an error.
      expect(await recordProposalView(db, organisationId, { token: "nope", now: NOW })).toBeNull();
      expect(await recordProposalView(db, organisationId, { token: "a".repeat(32), now: NOW })).toBeNull();
      // And the whole page reads by token alone.
      const publicView = await getPublicProposal(db, token);
      expect(publicView!.proposal.id).toBe(proposal.id);
      expect(await getPublicProposal(db, "a".repeat(32))).toBeNull();
    });
  });

  it("records a decline once and refuses one on a proposal already accepted", async () => {
    await withTestDb(async (db) => {
      catchFollowOn();
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const make = async (title: string) => {
        const { proposal } = await createProposal(db, organisationId, {
          leadId, title, pricing: MONTHLY, lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }],
          actorId: ownerUserId, now: NOW,
        });
        await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
        return proposal;
      };

      const declined = await make("Care");
      const first = await declineProposal(db, organisationId, { token: declined.publicToken, reason: "Too much just now", now: NOW });
      expect(first).toMatchObject({ recorded: true });
      expect(first.proposal).toMatchObject({ status: "declined" });
      expect(first.proposal.metadata["declineReason"]).toBe("Too much just now");
      const again = await declineProposal(db, organisationId, { token: declined.publicToken, now: NOW });
      expect(again.recorded).toBe(false);
      expect((await notices(db, organisationId)).filter((n) => n.notice === "declined")).toHaveLength(1);

      const accepted = await make("Second");
      await acceptProposal(db, organisationId, { token: accepted.publicToken, acceptedName: "Aisha Khan", acceptedEmail: "aisha@example.test", now: NOW }, ENV);
      await expect(declineProposal(db, organisationId, { token: accepted.publicToken, now: NOW }))
        .rejects.toThrow(/no longer open for a decision/);
    });
  });
});

describe("acceptance", () => {
  it("writes the record, turns the lead into a client, moves the paperwork across and hands the rest to the queue", async () => {
    await withTestDb(async (db) => {
      const jobs = catchFollowOn();
      const { organisationId, ownerUserId, leadId, packageId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Website and care plan", pricing: { shape: "setup_plus_monthly", packageId },
        lines: [{ kind: "setup", description: "Build", unitPence: 120_000 }, { kind: "monthly", description: "Care", unitPence: 25_000 }],
        actorId: ownerUserId, now: NOW,
      });
      const sent = await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);

      const accepted = await acceptProposal(db, organisationId, {
        token: proposal.publicToken,
        acceptedName: "Aisha Khan",
        acceptedEmail: "Aisha@Example.Test",
        signatureSvg: "M 10 100 C 40 20, 65 20, 95 100 S 150 180, 180 100",
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0 (iPhone)",
        now: NOW,
      }, ENV);

      expect(accepted.alreadyAccepted).toBe(false);
      expect(accepted.proposal).toMatchObject({ status: "accepted", clientId: accepted.clientId });
      expect(accepted.proposal.decidedAt?.toISOString()).toBe(NOW.toISOString());
      expect(accepted.acceptance).toMatchObject({
        proposalId: proposal.id, acceptedName: "Aisha Khan", acceptedEmail: "aisha@example.test",
        ip: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone)",
      });
      expect(accepted.acceptance.signatureSvg).toContain("M 10 100 C");

      // The lead is now a client, through the one conversion that already existed.
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId));
      expect(lead!.status).toBe("converted");
      expect(lead!.clientId).toBe(accepted.clientId);
      const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, accepted.clientId!));
      expect(client).toMatchObject({ name: "Khan Dental", email: "aisha@example.test", packageId });

      // The PDF they were sent now belongs to them, so their portal can read it.
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, sent.document.id));
      expect(document!.clientId).toBe(accepted.clientId);

      const queued = await notices(db, organisationId);
      expect(queued.filter((n) => n.notice === "accepted")).toHaveLength(1);
      expect(queued.find((n) => n.notice === "accepted")!.body).toContain("payment link");
      const bells = await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.kind, "proposal.accepted")));
      expect(bells).toHaveLength(1);

      expect(jobs).toEqual([{
        organisationId, proposalId: proposal.id, acceptanceId: accepted.acceptance.id, clientId: accepted.clientId,
        shape: "setup_plus_monthly", dueOnAcceptancePence: 120_000, recurringMonthlyPence: 25_000, packageId,
      }]);
      const [after] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, proposal.id));
      expect(typeof after!.metadata["followOnQueuedAt"]).toBe("string");
      expect(await proposalsAwaitingFollowOn(db, organisationId)).toEqual([]);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "proposal.accepted")));
      expect(audits).toHaveLength(1);
    });
  });

  it("gives a client who taps Accept twice one acceptance, one email and one alert", async () => {
    await withTestDb(async (db) => {
      const jobs = catchFollowOn();
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Care", pricing: MONTHLY, lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }],
        actorId: ownerUserId, now: NOW,
      });
      await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      const tap = { token: proposal.publicToken, acceptedName: "Aisha Khan", acceptedEmail: "aisha@example.test", now: NOW };

      const first = await acceptProposal(db, organisationId, tap, ENV);
      const second = await acceptProposal(db, organisationId, { ...tap, acceptedName: "Somebody Else" }, ENV);

      expect(second.alreadyAccepted).toBe(true);
      expect(second.acceptance.id).toBe(first.acceptance.id);
      expect(second.acceptance.acceptedName).toBe("Aisha Khan");
      const rows = await db.select().from(schema.proposalAcceptances).where(eq(schema.proposalAcceptances.proposalId, proposal.id));
      expect(rows).toHaveLength(1);
      expect((await notices(db, organisationId)).filter((n) => n.notice === "accepted")).toHaveLength(1);
      expect(await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.kind, "proposal.accepted")))).toHaveLength(1);
      expect(jobs).toHaveLength(1);
    });
  });

  it("refuses an acceptance on a draft, and one made after the last day in London", async () => {
    await withTestDb(async (db) => {
      catchFollowOn();
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const lines = [{ kind: "monthly" as const, description: "Care", unitPence: 15_000 }];
      const draft = await createProposal(db, organisationId, { leadId, title: "Draft", pricing: MONTHLY, lines, actorId: ownerUserId, now: NOW });
      await expect(acceptProposal(db, organisationId, {
        token: draft.proposal.publicToken, acceptedName: "A", acceptedEmail: "a@example.test", now: NOW,
      }, ENV)).rejects.toThrow(/no longer open for a decision/);

      const dated = await createProposal(db, organisationId, {
        leadId, title: "Dated", pricing: MONTHLY, lines, validUntil: "2026-09-30", actorId: ownerUserId, now: NOW,
      });
      await sendProposal(db, organisationId, { proposalId: dated.proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);

      // 30 September 2026 is BST, so the last moment is 22:59:59Z — a client
      // accepting at 23:30 London time on the day is still in time.
      expect(proposalExpiresAt("2026-09-30")!.toISOString()).toBe("2026-09-30T23:00:00.000Z");
      const inTime = await acceptProposal(db, organisationId, {
        token: dated.proposal.publicToken, acceptedName: "Aisha", acceptedEmail: "aisha@example.test",
        now: new Date("2026-09-30T22:30:00Z"),
      }, ENV);
      expect(inTime.alreadyAccepted).toBe(false);

      const late = await createProposal(db, organisationId, {
        leadId, title: "Late", pricing: MONTHLY, lines, validUntil: "2026-09-30", actorId: ownerUserId, now: NOW,
      });
      await sendProposal(db, organisationId, { proposalId: late.proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      await expect(acceptProposal(db, organisationId, {
        token: late.proposal.publicToken, acceptedName: "Aisha", acceptedEmail: "aisha@example.test",
        now: new Date("2026-09-30T23:30:00Z"),
      }, ENV)).rejects.toThrow(/expired/);
    });
  });

  it("refuses a signature that is anything but path data", async () => {
    await withTestDb(async (db) => {
      catchFollowOn();
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const { proposal } = await createProposal(db, organisationId, {
        leadId, title: "Care", pricing: MONTHLY, lines: [{ kind: "monthly", description: "Care", unitPence: 15_000 }],
        actorId: ownerUserId, now: NOW,
      });
      await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
      await expect(acceptProposal(db, organisationId, {
        token: proposal.publicToken, acceptedName: "A", acceptedEmail: "a@example.test",
        signatureSvg: `<svg onload="alert(1)"><path d="M0 0"/></svg>`, now: NOW,
      }, ENV)).rejects.toThrow(/SVG path data/);
      expect(await getProposalAcceptance(db, organisationId, proposal.id)).toBeNull();
    });
  });
});

describe("the daily sweeps", () => {
  it("expires only what is genuinely past its last London day, and nudges an unopened proposal once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, leadId } = await leadFixture(db);
      const lines = [{ kind: "monthly" as const, description: "Care", unitPence: 15_000 }];
      const make = async (title: string, validUntil: string) => {
        const { proposal } = await createProposal(db, organisationId, { leadId, title, pricing: MONTHLY, lines, validUntil, actorId: ownerUserId, now: NOW });
        await sendProposal(db, organisationId, { proposalId: proposal.id, actorId: ownerUserId, now: NOW }, undefined, ENV);
        return proposal;
      };
      const gone = await make("Gone", "2026-09-30");
      const standing = await make("Standing", "2026-10-31");

      // 08:00 on 1 October is past the end of 30 September; the other stands.
      const swept = await expireProposals(db, organisationId, { now: new Date("2026-10-01T08:00:00Z") });
      expect(swept.expired.map((p) => p.id)).toEqual([gone.id]);
      expect(swept.expired[0]!.status).toBe("expired");
      expect((await getProposalDetail(db, organisationId, standing.id))!.proposal.status).toBe("sent");
      // A second pass finds nothing left to do.
      expect((await expireProposals(db, organisationId, { now: new Date("2026-10-01T08:00:00Z") })).expired).toEqual([]);

      const nudged = await nudgeUnopenedProposals(db, organisationId, { now: new Date("2026-09-11T09:00:00Z") });
      expect(nudged.nudged.map((p) => p.id)).toEqual([standing.id]);
      expect((await nudgeUnopenedProposals(db, organisationId, { now: new Date("2026-09-12T09:00:00Z") })).nudged).toEqual([]);
      const bells = await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, organisationId), eq(schema.notifications.kind, "proposal.unopened")));
      expect(bells).toHaveLength(1);
    });
  });
});

describe("tenancy", () => {
  it("keeps every read and every write inside the organisation that owns the proposal", async () => {
    await withTestDb(async (db) => {
      catchFollowOn();
      const mine = await leadFixture(db);
      const theirs = await leadFixture(db);
      const lines = [{ kind: "monthly" as const, description: "Care", unitPence: 15_000 }];
      const { proposal } = await createProposal(db, mine.organisationId, {
        leadId: mine.leadId, title: "Mine", pricing: MONTHLY, lines, actorId: mine.ownerUserId, now: NOW,
      });
      await sendProposal(db, mine.organisationId, { proposalId: proposal.id, actorId: mine.ownerUserId, now: NOW }, undefined, ENV);

      // Reads.
      expect(await getProposalDetail(db, theirs.organisationId, proposal.id)).toBeNull();
      expect(await listProposals(db, theirs.organisationId)).toEqual([]);
      // The public token is worth nothing in the wrong organisation.
      expect(await recordProposalView(db, theirs.organisationId, { token: proposal.publicToken, now: NOW })).toBeNull();
      await expect(acceptProposal(db, theirs.organisationId, {
        token: proposal.publicToken, acceptedName: "Thief", acceptedEmail: "thief@example.test", now: NOW,
      }, ENV)).rejects.toThrow(/could not be found/);
      await expect(declineProposal(db, theirs.organisationId, { token: proposal.publicToken, now: NOW }))
        .rejects.toThrow(/could not be found/);
      // Writes.
      await expect(updateProposal(db, theirs.organisationId, { proposalId: proposal.id, title: "Theirs", actorId: theirs.ownerUserId }))
        .rejects.toThrow(/could not be found/);
      await expect(addProposalLine(db, theirs.organisationId, { proposalId: proposal.id, kind: "monthly", description: "x", unitPence: 1, actorId: theirs.ownerUserId }))
        .rejects.toThrow(/could not be found/);
      await expect(sendProposal(db, theirs.organisationId, { proposalId: proposal.id, actorId: theirs.ownerUserId }, undefined, ENV))
        .rejects.toThrow(/could not be found/);
      // Sweeps.
      expect((await expireProposals(db, theirs.organisationId, { now: new Date("2027-01-01T00:00:00Z") })).expired).toEqual([]);
      expect((await nudgeUnopenedProposals(db, theirs.organisationId, { now: new Date("2026-10-01T00:00:00Z") })).nudged).toEqual([]);
      // And a proposal cannot be written for another organisation's lead.
      await expect(createProposal(db, mine.organisationId, { leadId: theirs.leadId, title: "Reach", pricing: MONTHLY, actorId: mine.ownerUserId }))
        .rejects.toThrow(/not found in organisation/);
    });
  });
});
