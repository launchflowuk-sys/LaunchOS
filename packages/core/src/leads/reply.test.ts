import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { decideApproval } from "../approvals/decide-approval.js";
import { LEAD_REPLY_KIND } from "../support/send-queued-message.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { bookingLinkFor } from "./booking-link.js";
import { createLead } from "./leads.js";
import { LEAD_REPLY_ACTION, LeadReplyPayload, LeadReplyRefused, applyLeadReplyDecision, listLeadMessages, requestLeadReply } from "./reply.js";

const env = { APP_URL: "https://os.launchflow.test", SUPPORT_CONTACT_EMAIL: "hello@launchflow.test" } as NodeJS.ProcessEnv;

async function leadWithPackage(db: Parameters<typeof createLead>[0]) {
  const seed = await seedOrgWithClient(db);
  await db.update(schema.packages).set({ slug: "starter", name: "Starter", monthlyPricePence: 9900 }).where(eq(schema.packages.id, seed.packageId));
  const lead = await createLead(db, seed.organisationId, {
    name: "Aisha Khan", email: "aisha@example.test", business: "Khan Dental", message: "How much for a five-page site?", source: "website",
  }, env);
  return { ...seed, lead };
}

describe("lead reply approval", () => {
  it("raises one run-less lead_reply card with the enquiry, the draft and the package, bells the owner urgently, and refuses a second while pending", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, lead } = await leadWithPackage(db);
      const { approval, payload } = await requestLeadReply(db, organisationId, {
        leadId: lead.id, subject: "Your website for Khan Dental", body: "Thanks Aisha — two quick questions.",
        suggestedPackageSlug: "starter", questions: ["How many pages?", "Do you have photos?"], actorKind: "agent", actorId: "lead-qualifier",
      }, env);
      expect(approval).toMatchObject({ kind: LEAD_REPLY_ACTION, status: "pending", runId: null, title: "Reply to Khan Dental: Your website for Khan Dental" });
      expect(LeadReplyPayload.parse(approval.payload)).toEqual(payload);
      expect(payload).toMatchObject({
        action: "lead_reply", leadId: lead.id, leadEmail: "aisha@example.test", leadMessage: "How much for a five-page site?",
        suggestedPackageSlug: "starter", suggestedPackageName: "Starter", suggestedPackageMonthlyPence: 9900,
        questions: ["How many pages?", "Do you have photos?"], bookingUrl: bookingLinkFor(lead, env), requestedById: "lead-qualifier",
      });
      const [bell] = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "approval.requested")));
      expect(bell!.title).toBe("Approve: reply to Khan Dental");
      expect(bell!.body).toContain("suggests Starter");

      await expect(requestLeadReply(db, organisationId, { leadId: lead.id, subject: "Again", body: "x" }, env))
        .rejects.toMatchObject({ reason: "already_pending" });
      // An unknown package is simply not suggested.
      const other = await createLead(db, organisationId, { name: "B", email: "b@example.test", source: "website" }, env);
      const { payload: bare } = await requestLeadReply(db, organisationId, { leadId: other.id, subject: "Hi", body: "x", suggestedPackageSlug: "nope" }, env);
      expect(bare.suggestedPackageSlug).toBeNull();
    });
  });

  it("approving queues the branded reply (edited body wins) with the booking link, moves the lead to contacted, and applies once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, lead } = await leadWithPackage(db);
      const { approval } = await requestLeadReply(db, organisationId, { leadId: lead.id, subject: "Your website", body: "Draft body." }, env);
      await decideApproval(db, organisationId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerUserId });
      // Same transaction, same now(): date the acknowledgement back so the thread order is not a coin toss.
      const [ack] = await listLeadMessages(db, organisationId, lead.id);
      await db.update(schema.messages).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(schema.messages.id, ack!.id));

      const result = await applyLeadReplyDecision(db, organisationId, { approvalId: approval.id, actorId: ownerUserId, body: "Edited body, sent as typed." }, env);
      expect(result).toMatchObject({ decision: "approved", leadId: lead.id, alreadyApplied: false });
      const message = result.message!;
      expect(message).toMatchObject({ direction: "outbound", status: "queued", authorKind: "user", authorId: ownerUserId, toEmail: "aisha@example.test", subject: "Your website" });
      expect(message.body.startsWith("Edited body, sent as typed.")).toBe(true);
      expect(message.body).toContain(bookingLinkFor(lead, env));
      expect(message.metadata).toMatchObject({ kind: LEAD_REPLY_KIND, leadId: lead.id, approvalId: approval.id, edited: true });

      // On the same thread as the acknowledgement.
      const thread = await listLeadMessages(db, organisationId, lead.id);
      expect(thread.map((m) => m.metadata["kind"])).toEqual(["lead_acknowledgement", LEAD_REPLY_KIND]);

      const [after] = await db.select().from(schema.leads).where(eq(schema.leads.id, lead.id));
      expect(after!.status).toBe("contacted");
      const timeline = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "lead.replied")));
      expect(timeline).toHaveLength(1);

      const again = await applyLeadReplyDecision(db, organisationId, { approvalId: approval.id, actorId: ownerUserId }, env);
      expect(again).toMatchObject({ alreadyApplied: true, message: null });
      expect(await listLeadMessages(db, organisationId, lead.id)).toHaveLength(2);

      // The draft is unspent for a fresh card now the first is decided.
      const second = await requestLeadReply(db, organisationId, { leadId: lead.id, subject: "Follow-up", body: "More." }, env);
      expect(second.approval.status).toBe("pending");
    });
  });

  it("rejecting sends nothing and leaves a timeline note; a converted lead or one without email is refused", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, lead } = await leadWithPackage(db);
      const { approval } = await requestLeadReply(db, organisationId, { leadId: lead.id, subject: "Your website", body: "Draft." }, env);
      await decideApproval(db, organisationId, { approvalId: approval.id, decision: "rejected", decidedByUserId: ownerUserId, note: "Too salesy" });
      const result = await applyLeadReplyDecision(db, organisationId, { approvalId: approval.id, actorId: ownerUserId }, env);
      expect(result).toMatchObject({ decision: "rejected", message: null, alreadyApplied: false });
      expect((await listLeadMessages(db, organisationId, lead.id)).map((m) => m.metadata["kind"])).toEqual(["lead_acknowledgement"]);
      const [note] = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "lead.reply_rejected")));
      expect(note!.body).toBe("Too salesy");
      const [after] = await db.select().from(schema.leads).where(eq(schema.leads.id, lead.id));
      expect(after!.status).toBe("new");

      const silent = await createLead(db, organisationId, { name: "No email", source: "manual" }, env);
      await expect(requestLeadReply(db, organisationId, { leadId: silent.id, subject: "s", body: "b" }, env)).rejects.toBeInstanceOf(LeadReplyRefused);
    });
  });

  it("keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await leadWithPackage(db);
      const b = await seedOrgWithClient(db);
      await expect(requestLeadReply(db, b.organisationId, { leadId: a.lead.id, subject: "s", body: "b" }, env)).rejects.toMatchObject({ reason: "not_found" });
      const { approval } = await requestLeadReply(db, a.organisationId, { leadId: a.lead.id, subject: "s", body: "b" }, env);
      await decideApproval(db, a.organisationId, { approvalId: approval.id, decision: "approved", decidedByUserId: a.ownerUserId });
      await expect(applyLeadReplyDecision(db, b.organisationId, { approvalId: approval.id, actorId: b.ownerUserId }, env)).rejects.toThrow(/not found in organisation/);
      expect(await listLeadMessages(db, b.organisationId, a.lead.id)).toEqual([]);
    });
  });
});
