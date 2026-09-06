import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createLead, getProposalDetail, sendProposal } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildContext } from "../kernel/run-loop.js";
import { meetingsGetNotes } from "./meetings-get-notes.js";
import { proposalRequestApproval } from "./proposal-request-approval.js";
import { proposalSaveDraft } from "./proposal-save-draft.js";
import { PROPOSAL_DRAFTER_KEY } from "./proposal-shared.js";

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-07T10:00:00Z");

interface Fixture {
  orgId: string;
  ownerId: string;
  leadId: string;
  packageSlug: string;
}

async function fixture(db: Db, options: { notes?: string | null } = {}): Promise<Fixture> {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `pd-${randomUUID()}` }).returning();
  const orgId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: ownerId, role: "owner", status: "active" });
  await db.insert(schema.packages).values({
    organisationId: orgId, name: "Care", slug: "care", monthlyPricePence: 9900, setupPricePence: 0, active: true,
  });
  const lead = await createLead(db, orgId, {
    name: "Aisha Khan", business: "Khan Dental", email: "aisha@khandental.test", source: "website",
    message: "We need a new website.", notifyOwner: false, acknowledge: false,
  });
  await db.insert(schema.meetings).values({
    organisationId: orgId, kind: "discovery", leadId: lead.id, hostUserId: ownerId,
    guestName: "Aisha Khan", guestEmail: "aisha@khandental.test",
    startsAt: new Date("2026-09-05T13:00:00Z"), endsAt: new Date("2026-09-05T13:30:00Z"),
    status: "completed", provider: "mock", joinUrl: "https://example.test/j", rescheduleToken: randomUUID(),
    notes: options.notes === undefined ? "Six pages, no existing site. Wants a care plan. Budget around £1,000 to start." : options.notes,
  });
  return { orgId, ownerId, leadId: lead.id, packageSlug: "care" };
}

async function ctxFor(db: Db, orgId: string) {
  const [run] = await db.insert(schema.agentRuns)
    .values({ organisationId: orgId, agentKey: PROPOSAL_DRAFTER_KEY, trigger: "manual" }).returning();
  const ctx = buildContext(db, orgId, run!.id, quiet);
  return { ...ctx, now: () => NOW };
}

const draft = (f: Fixture, over: Record<string, unknown> = {}) => ({
  leadId: f.leadId,
  title: "Website and monthly care for Khan Dental",
  summary: "Six pages, built and launched, then £99 a month to look after it. £1,200 to start, then £99 a month.",
  shape: "setup_plus_monthly" as const,
  packageSlug: f.packageSlug,
  deliverables: ["Six-page website, designed and built", "Hosting, updates and backups every month"],
  outOfScope: ["Copywriting beyond the pages you supply"],
  timeline: "Four to five working weeks from sign-off and the content arriving.",
  lines: [
    { kind: "setup" as const, description: "Six-page website, designed and built", quantity: 1, unitPence: 120_000 },
    { kind: "monthly" as const, description: "Care plan", quantity: 1, unitPence: 9_900 },
  ],
  ...over,
});

describe("meetings_get_notes", () => {
  it("hands over the discovery call's notes for a lead, and nothing from another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      const ctx = await ctxFor(db, mine.orgId);

      const out = await meetingsGetNotes.execute({ leadId: mine.leadId }, ctx);
      expect(out.meetings).toHaveLength(1);
      expect(out.meetings[0]).toMatchObject({ kind: "discovery", held: true });
      expect(out.meetings[0]!.notes).toContain("Six pages");

      // Another tenant's lead id matches nothing, even though the row exists.
      const foreign = await meetingsGetNotes.execute({ leadId: theirs.leadId }, ctx);
      expect(foreign.meetings).toEqual([]);
      // Nothing to scope by is a refusal, not a listing of every meeting.
      expect((await meetingsGetNotes.execute({}, ctx)).meetings).toEqual([]);
    });
  });

  it("says a call happened with no notes rather than pretending there was no call", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { notes: null });
      const out = await meetingsGetNotes.execute({ leadId: f.leadId }, await ctxFor(db, f.orgId));
      expect(out.meetings).toHaveLength(1);
      expect(out.meetings[0]!.notes).toBeNull();
      expect(out.meetings[0]!.held).toBe(true);
    });
  });
});

describe("proposal_save_draft", () => {
  it("writes a draft whose price is the sum of its lines, and never a figure the tool was handed", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const out = await proposalSaveDraft.execute(draft(f), await ctxFor(db, f.orgId));
      expect(out.saved).toBe(true);
      if (!out.saved) return;
      expect(out.reference).toMatch(/^P-\d{4}-\d{3}$/);
      expect(out.dueOnAcceptancePence).toBe(120_000);
      expect(out.recurringMonthlyPence).toBe(9_900);
      expect(out.priceSentence).toBe("£1,200.00 to start, then £99.00 a month.");

      const detail = (await getProposalDetail(db, f.orgId, out.proposalId))!;
      expect(detail.proposal.status).toBe("draft");
      expect(detail.proposal.pricing).toMatchObject({ shape: "setup_plus_monthly", setupPence: 120_000, monthlyPence: 9_900, oneOffPence: 0 });
      expect(detail.proposal.packageId).not.toBeNull();
      expect(detail.lines).toHaveLength(2);
      // The write is the agent's, and the audit trail says so.
      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, f.orgId), eq(schema.auditLog.action, "proposal.created")));
      expect(audit).toMatchObject({ actorKind: "agent", actorId: PROPOSAL_DRAFTER_KEY });
    });
  });

  it("refuses a line the shape cannot carry, and writes nothing, so the retry is clean", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const refused = await proposalSaveDraft.execute(
        draft(f, { shape: "one_off", lines: [{ kind: "monthly", description: "Care plan", quantity: 1, unitPence: 9_900 }] }),
        ctx,
      );
      expect(refused.saved).toBe(false);
      if (refused.saved) return;
      expect(refused.reason).toMatch(/one-off proposal cannot carry monthly/i);
      expect(await db.select().from(schema.proposals).where(eq(schema.proposals.organisationId, f.orgId))).toEqual([]);

      // The same run fixes it and saves; nothing from the refusal is in the way.
      const fixed = await proposalSaveDraft.execute(draft(f), ctx);
      expect(fixed.saved).toBe(true);
    });
  });

  it("refuses an unknown package slug and a second draft for the same lead, handing back the first one's id", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const wrongPackage = await proposalSaveDraft.execute(draft(f, { packageSlug: "not-a-package" }), ctx);
      expect(wrongPackage.saved).toBe(false);
      if (!wrongPackage.saved) expect(wrongPackage.reason).toContain("no active package");

      const first = await proposalSaveDraft.execute(draft(f), ctx);
      expect(first.saved).toBe(true);
      const second = await proposalSaveDraft.execute(draft(f, { title: "Another go" }), ctx);
      expect(second.saved).toBe(false);
      if (second.saved || first.saved !== true) return;
      expect(second.proposalId).toBe(first.proposalId);
      expect(await db.select().from(schema.proposals).where(eq(schema.proposals.organisationId, f.orgId))).toHaveLength(1);
    });
  });
});

describe("proposal_request_approval", () => {
  it("raises the card, sends nothing, and leaves the proposal a draft", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const saved = await proposalSaveDraft.execute(draft(f), ctx);
      if (!saved.saved) throw new Error("draft not saved");

      const out = await proposalRequestApproval.execute({ proposalId: saved.proposalId }, ctx);
      expect(out.requested).toBe(true);
      if (!out.requested) return;

      const [approval] = await db.select().from(schema.approvals)
        .where(and(eq(schema.approvals.organisationId, f.orgId), eq(schema.approvals.id, out.approvalId)));
      expect(approval).toMatchObject({ kind: "proposal_send", status: "pending", runId: null });
      expect(approval!.payload).toMatchObject({
        action: "proposal_send",
        proposalId: saved.proposalId,
        recipientEmail: "aisha@khandental.test",
        shape: "setup_plus_monthly",
        dueOnAcceptancePence: 120_000,
        requestedByKind: "agent",
        requestedById: PROPOSAL_DRAFTER_KEY,
      });
      // The gate held: still a draft, and not a single message queued.
      const detail = (await getProposalDetail(db, f.orgId, saved.proposalId))!;
      expect(detail.proposal.status).toBe("draft");
      expect(detail.proposal.sentAt).toBeNull();
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.orgId))).toEqual([]);

      // Asked twice, one card: the pending index has the final word.
      const again = await proposalRequestApproval.execute({ proposalId: saved.proposalId }, ctx);
      expect(again.requested).toBe(false);
      if (!again.requested) expect(again.reason).toMatch(/already waiting/i);
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId))).toHaveLength(1);
    });
  });

  it("refuses a proposal that has already gone out, so a re-run cannot ask to send it twice", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const saved = await proposalSaveDraft.execute(draft(f), ctx);
      if (!saved.saved) throw new Error("draft not saved");
      await sendProposal(db, f.orgId, { proposalId: saved.proposalId, actorKind: "user", actorId: f.ownerId });

      const out = await proposalRequestApproval.execute({ proposalId: saved.proposalId }, ctx);
      expect(out.requested).toBe(false);
      if (!out.requested) expect(out.reason).toMatch(/already been sent/i);
    });
  });

  it("refuses a lead with no email address rather than raising a card nobody can approve", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.orgId);
      const saved = await proposalSaveDraft.execute(draft(f), ctx);
      if (!saved.saved) throw new Error("draft not saved");
      await db.update(schema.leads).set({ email: null }).where(eq(schema.leads.id, f.leadId));

      const out = await proposalRequestApproval.execute({ proposalId: saved.proposalId }, ctx);
      expect(out.requested).toBe(false);
      if (!out.requested) expect(out.reason).toMatch(/no email address/i);
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, f.orgId))).toEqual([]);
    });
  });
});
