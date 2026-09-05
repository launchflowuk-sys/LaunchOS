import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { decideApproval } from "../approvals/decide-approval.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { SUBSCRIPTION_CHANGE_NOTICE_KIND, isCourtesyNotice } from "../support/courtesy-notice.js";
import { sendQueuedMessage } from "../support/send-queued-message.js";
import { applySubscriptionChangeDecision } from "./subscription-change-decision.js";
import {
  findPendingSubscriptionChange,
  latestSubscriptionChange,
  requestSubscriptionChange,
  SUBSCRIPTION_CHANGE_ACTION,
  SubscriptionChangeRefused,
} from "./subscription-change-request.js";

const ENV = { APP_URL: "https://os.launchflow.test", SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "support@launchflow.test" };
const PERIOD_END = new Date("2026-09-30T23:59:59Z");

async function withCapturedEvents<T>(run: (events: DomainEvent[]) => Promise<T>): Promise<T> {
  const events: DomainEvent[] = [];
  setEnqueue(async (event) => {
    events.push(event);
  });
  try {
    return await run(events);
  } finally {
    setEnqueue(async () => {});
  }
}

/** An organisation with an owner, a client on the Growth package and two portal users. */
async function fixture(db: Db, opts: { withSubscription?: boolean; portalUsers?: number } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `chg-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });

  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test" })
    .returning();
  const [pkg] = await db.insert(schema.packages)
    .values({ organisationId: org!.id, name: "Growth", slug: `growth-${randomUUID()}`, monthlyPricePence: 14900, setupPricePence: 0 })
    .returning();

  const portalUserIds: string[] = [];
  for (let i = 0; i < (opts.portalUsers ?? 2); i += 1) {
    const userId = randomUUID();
    await db.insert(schema.user).values({ id: userId, name: `Portal ${i}`, email: `portal-${i}-${userId}@grays.test`, emailVerified: true });
    await db.insert(schema.clientUsers).values({ organisationId: org!.id, clientId: client!.id, userId, role: "client_admin" });
    portalUserIds.push(userId);
  }

  const [subscription] = opts.withSubscription === false
    ? []
    : await db.insert(schema.subscriptions).values({
        organisationId: org!.id, clientId: client!.id, packageId: pkg!.id, status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: PERIOD_END,
        amountPence: 14900, currency: "GBP", stripeSubscriptionId: `sub_${randomUUID()}`,
      }).returning();

  return { orgId: org!.id, ownerId, clientId: client!.id, packageId: pkg!.id, subscription, portalUserIds };
}

function notices(db: Db, organisationId: string) {
  return db.select().from(schema.messages).where(and(
    eq(schema.messages.organisationId, organisationId),
    isCourtesyNotice(),
  ));
}

describe("requestSubscriptionChange", () => {
  it("parks a subscription_change approval with a summary written from our own rows", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, subscription, portalUserIds } = await fixture(db);

      const approval = await requestSubscriptionChange(db, orgId, {
        clientId, actorUserId: portalUserIds[0]!, kind: "cancel", message: "We are closing the office in October.",
      });

      expect(approval.kind).toBe("subscription_change");
      expect(approval.status).toBe("pending");
      expect(approval.runId).toBeNull();
      expect(approval.title).toBe("Grays CabLine: cancel my plan");
      expect(approval.payload).toMatchObject({
        action: SUBSCRIPTION_CHANGE_ACTION,
        clientId,
        clientName: "Grays CabLine",
        subscriptionId: subscription!.id,
        packageName: "Growth",
        monthlyPricePence: 14900,
        kind: "cancel",
        message: "We are closing the office in October.",
        summary: "Grays CabLine asks to cancel the Growth package (£149/month), reason: We are closing the office in October.",
      });

      const audit = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "subscription.change_requested"),
      ));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorKind).toBe("client");
      expect(audit[0]!.actorId).toBe(portalUserIds[0]);

      const activity = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.clientId, clientId), eq(schema.activityEvents.kind, "subscription.change_requested"),
      ));
      expect(activity).toHaveLength(1);

      const owner = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, orgId));
      expect(owner.map((n) => n.kind)).toEqual(["subscription.change_requested"]);

      expect((await findPendingSubscriptionChange(db, orgId, clientId))?.id).toBe(approval.id);
      expect((await latestSubscriptionChange(db, orgId, clientId))?.id).toBe(approval.id);
    });
  });

  it("refuses when the client has no active subscription", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserIds } = await fixture(db, { withSubscription: false });

      await expect(
        requestSubscriptionChange(db, orgId, { clientId, actorUserId: portalUserIds[0]!, kind: "upgrade", message: "More posts please." }),
      ).rejects.toMatchObject({ name: "SubscriptionChangeRefused", reason: "no_active_subscription" });
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId))).toHaveLength(0);
    });
  });

  it("refuses a second request while one is still waiting", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserIds } = await fixture(db);
      await requestSubscriptionChange(db, orgId, { clientId, actorUserId: portalUserIds[0]!, kind: "downgrade", message: "Too much." });

      const second = requestSubscriptionChange(db, orgId, { clientId, actorUserId: portalUserIds[1]!, kind: "cancel", message: "Actually, stop." });
      await expect(second).rejects.toBeInstanceOf(SubscriptionChangeRefused);
      await expect(second).rejects.toMatchObject({ reason: "already_pending" });
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId))).toHaveLength(1);
    });
  });

  it("is invisible to another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserIds } = await fixture(db);
      const other = await fixture(db);
      await requestSubscriptionChange(db, orgId, { clientId, actorUserId: portalUserIds[0]!, kind: "other", message: "Add ads." });

      expect(await findPendingSubscriptionChange(db, other.orgId, clientId)).toBeUndefined();
      expect(await latestSubscriptionChange(db, other.orgId, clientId)).toBeUndefined();
      // Nor can the other organisation raise one against a client it does not own.
      await expect(
        requestSubscriptionChange(db, other.orgId, { clientId, actorUserId: "x", kind: "cancel", message: "Not mine." }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});

describe("applySubscriptionChangeDecision", () => {
  it("approving a cancel ends the subscription at period end and emails every portal user", async () => {
    await withTestDb(async (db) => {
      await withCapturedEvents(async (events) => {
        const { orgId, ownerId, clientId, subscription, portalUserIds } = await fixture(db);
        const approval = await requestSubscriptionChange(db, orgId, {
          clientId, actorUserId: portalUserIds[0]!, kind: "cancel", message: "Closing down.",
        });
        const decided = await decideApproval(db, orgId, {
          approvalId: approval.id, decision: "approved", decidedByUserId: ownerId, note: "Sorry to see you go.",
        });
        expect(decided.alreadyDecided).toBe(false);
        events.length = 0;

        const result = await applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV);

        expect(result).toMatchObject({ decision: "approved", kind: "cancel", cancelled: true, alreadyApplied: false });
        expect(result.notices).toHaveLength(2);

        const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subscription!.id));
        expect(after!.status).toBe("cancelled");
        expect(after!.metadata).toMatchObject({ cancelAtPeriodEnd: PERIOD_END.toISOString(), cancelledByApprovalId: approval.id });

        const queued = await notices(db, orgId);
        expect(queued.map((m) => m.toEmail).sort()).toEqual(
          (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, portalUserIds[0]!)))
            .map((u) => u.email)
            .concat((await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, portalUserIds[1]!))).map((u) => u.email))
            .sort(),
        );
        for (const notice of queued) {
          expect(notice.status).toBe("queued");
          expect(notice.metadata).toMatchObject({ kind: SUBSCRIPTION_CHANGE_NOTICE_KIND, decision: "approved", approvalId: approval.id });
          expect(notice.subject).toBe("Your request has been approved");
          expect(notice.body).toContain("ends at the close of the current billing period");
          expect(notice.body).toContain("LaunchFlow said: Sorry to see you go.");
        }
        expect(events.map((e) => e.name)).toEqual(["message.queued", "message.queued"]);

        const actions = (await db.select({ action: schema.auditLog.action }).from(schema.auditLog)
          .where(eq(schema.auditLog.organisationId, orgId))).map((a) => a.action);
        expect(actions).toContain("subscription.cancelled");
        expect(actions).toContain("subscription.change_approved");

        // The branded email says what happened and points at the plan page.
        const adapter = new MockEmailAdapter();
        await sendQueuedMessage(db, orgId, { messageId: queued[0]!.id }, adapter, ENV);
        expect(adapter.sent[0]!.html).toContain("Your request has been approved");
        expect(adapter.sent[0]!.html).toContain("https://os.launchflow.test/portal/plan");
        expect(adapter.sent[0]!.html).toContain("View your plan");
      });
    });
  });

  it("approving any other kind records the decision and leaves the subscription alone", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, subscription, portalUserIds } = await fixture(db, { portalUsers: 1 });
      const approval = await requestSubscriptionChange(db, orgId, {
        clientId, actorUserId: portalUserIds[0]!, kind: "upgrade", message: "We want the ads add-on.",
      });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      const result = await applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV);

      expect(result).toMatchObject({ decision: "approved", kind: "upgrade", cancelled: false });
      const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subscription!.id));
      expect(after!.status).toBe("active");
      const queued = await notices(db, orgId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.body).toContain("LaunchFlow will be in touch to arrange the change");
    });
  });

  it("rejecting records the decision, keeps the plan and tells the client it was declined", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, subscription, portalUserIds } = await fixture(db, { portalUsers: 1 });
      const approval = await requestSubscriptionChange(db, orgId, {
        clientId, actorUserId: portalUserIds[0]!, kind: "cancel", message: "Closing down.",
      });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "rejected", decidedByUserId: ownerId, note: "You are mid-contract." });

      const result = await applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV);

      expect(result).toMatchObject({ decision: "rejected", cancelled: false });
      const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, subscription!.id));
      expect(after!.status).toBe("active");
      const queued = await notices(db, orgId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.subject).toBe("Your request has been declined");
      expect(queued[0]!.metadata).toMatchObject({ decision: "rejected" });
      expect(queued[0]!.body).toContain("LaunchFlow said: You are mid-contract.");
      const actions = (await db.select({ action: schema.auditLog.action }).from(schema.auditLog)
        .where(eq(schema.auditLog.organisationId, orgId))).map((a) => a.action);
      expect(actions).toContain("subscription.change_rejected");
      expect(actions).not.toContain("subscription.cancelled");

      // Decided, so the client may ask again.
      expect(await findPendingSubscriptionChange(db, orgId, clientId)).toBeUndefined();
      expect((await latestSubscriptionChange(db, orgId, clientId))?.status).toBe("rejected");
    });
  });

  it("is applied at most once, and refuses an undecided approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, portalUserIds } = await fixture(db, { portalUsers: 1 });
      const approval = await requestSubscriptionChange(db, orgId, {
        clientId, actorUserId: portalUserIds[0]!, kind: "cancel", message: "Closing down.",
      });
      await expect(
        applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV),
      ).rejects.toThrow(/has not been decided/);

      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });
      const first = await applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV);
      const second = await applySubscriptionChangeDecision(db, orgId, { approvalId: approval.id, actorId: ownerId }, ENV);

      expect(first.alreadyApplied).toBe(false);
      expect(second).toMatchObject({ alreadyApplied: true, cancelled: false, notices: [] });
      expect(await notices(db, orgId)).toHaveLength(1);
    });
  });

  it("cannot be applied from another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId, portalUserIds } = await fixture(db, { portalUsers: 1 });
      const other = await fixture(db);
      const approval = await requestSubscriptionChange(db, orgId, {
        clientId, actorUserId: portalUserIds[0]!, kind: "cancel", message: "Closing down.",
      });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      await expect(
        applySubscriptionChangeDecision(db, other.orgId, { approvalId: approval.id, actorId: other.ownerId }, ENV),
      ).rejects.toThrow(/not found in organisation/);
      expect(await notices(db, orgId)).toHaveLength(0);
    });
  });
});
