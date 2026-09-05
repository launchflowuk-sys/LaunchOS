import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { emit } from "../events/emit.js";
import { SUBSCRIPTION_CHANGE_NOTICE_KIND } from "../support/courtesy-notice.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { SUBSCRIPTION_CHANGE_LABEL, SubscriptionChangePayload, type SubscriptionChangePayload as Payload } from "./subscription-change-request.js";

export const ApplySubscriptionChangeDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
});
export type ApplySubscriptionChangeDecisionInput = z.input<typeof ApplySubscriptionChangeDecisionInput>;

export interface ApplySubscriptionChangeDecisionResult {
  decision: "approved" | "rejected";
  kind: Payload["kind"];
  clientId: string;
  subscriptionId: string;
  /** True when the subscription row was moved to `cancelled` by this call. */
  cancelled: boolean;
  /** The courtesy emails queued for the client's portal users. */
  notices: (typeof schema.messages.$inferSelect)[];
  /** True when this approval had already been carried out; nothing was touched. */
  alreadyApplied: boolean;
}

/** Metadata stamped on the approval once its decision has been carried out. */
const APPLIED_AT = "appliedAt";

/** The stored body of the notice — the record of what the client was told. */
function noticeBody(decision: "approved" | "rejected", payload: Payload, note: string | null): string {
  const request = SUBSCRIPTION_CHANGE_LABEL[payload.kind].toLowerCase();
  const opening =
    decision === "approved"
      ? payload.kind === "cancel"
        ? `Your request to ${request} has been approved. Your ${payload.packageName} package ends at the close of the current billing period, and you will not be charged again after that.`
        : `Your request to ${request} has been approved. LaunchFlow will be in touch to arrange the change to your ${payload.packageName} package.`
      : `Your request to ${request} has been declined for now. Your ${payload.packageName} package carries on as it is.`;
  const reply = note ? `\n\nLaunchFlow said: ${note}` : "";
  return `${opening}${reply}\n\nIf you have any questions, raise a support request from your portal and we will pick it up.`;
}

/**
 * The portal users of this client, active only — a suspended login is somebody
 * who should not be told anything. Falls back to the client record's own
 * address so a client managed by email alone still hears the answer.
 */
async function recipientAddresses(db: Db, organisationId: string, clientId: string): Promise<string[]> {
  const users = await db
    .select({ email: schema.user.email })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(
      eq(schema.clientUsers.organisationId, organisationId),
      eq(schema.clientUsers.clientId, clientId),
      eq(schema.clientUsers.status, "active"),
    ));
  const addresses = [...new Set(users.map((u) => u.email.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length > 0) return addresses;

  const [client] = await db
    .select({ email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return client?.email ? [client.email] : [];
}

/**
 * Carries out a decided plan change request and tells the client.
 *
 * Called by the admin approvals action after `decideApproval` has stamped the
 * decision — for a rejection as much as an approval, because both are answers
 * the client is waiting on. At most once per approval: the claim is one
 * conditional UPDATE on `approvals.metadata.appliedAt`, so a doubled click or a
 * retry cannot cancel twice or email twice; a second call returns
 * `alreadyApplied` and touches nothing.
 *
 * What approving does depends on the request:
 *
 * - **cancel** moves the subscription to `cancelled`, recorded as ending at the
 *   close of the current period (`metadata.cancelAtPeriodEnd`). The provider
 *   is deliberately not called here — see the TODO below — so a cancellation
 *   in Stripe is still a manual step until that lands.
 * - **downgrade / upgrade / other** record the decision only. The package
 *   swap is a commercial conversation the owner has with the client, then
 *   makes on the client's billing tab.
 *
 * Either way a branded courtesy email goes to the client's portal users through
 * the same `messages` → `sendQueuedMessage` path every other outbound email
 * takes: one `queued` row per address on a conversation of its own, marked
 * `metadata.kind = subscription_change_notice` so no thread reader mistakes it
 * for a support message. The `message.queued` events are emitted after the
 * transaction commits.
 */
export async function applySubscriptionChangeDecision(
  db: Db,
  organisationId: string,
  input: ApplySubscriptionChangeDecisionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplySubscriptionChangeDecisionResult> {
  const v = ApplySubscriptionChangeDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);

  const [approval] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") {
    throw new Error(`approval ${v.approvalId} has not been decided`);
  }
  const decision = approval.status;
  const payload = SubscriptionChangePayload.parse(approval.payload);
  await assertOwned(db, organisationId, schema.subscriptions, payload.subscriptionId);

  const recipients = await recipientAddresses(db, organisationId, payload.clientId);
  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, payload.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);

  const applied = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();

    // The claim. Only one caller can flip `appliedAt` from null.
    const [claimed] = await tx
      .update(schema.approvals)
      .set({
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [APPLIED_AT]: now.toISOString(), appliedBy: v.actorId })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, v.approvalId),
        eq(schema.approvals.organisationId, organisationId),
        sql`(${schema.approvals.metadata}->>${APPLIED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return undefined;

    let cancelled = false;
    if (decision === "approved" && payload.kind === "cancel") {
      const [before] = await tx
        .select()
        .from(schema.subscriptions)
        .where(and(eq(schema.subscriptions.id, payload.subscriptionId), eq(schema.subscriptions.organisationId, organisationId)))
        .for("update");
      if (before && before.status !== "cancelled") {
        // TODO(stripe): call `payments.cancelSubscription(before.stripeSubscriptionId,
        // { atPeriodEnd: true })` here — the `StripePaymentsAdapter.cancelSubscription`
        // in packages/integrations — once the client-initiated cancel path is
        // wired to the provider. Until then the row is the record and the
        // Stripe subscription is cancelled by hand from the client's billing tab.
        const stamp = {
          cancelAtPeriodEnd: before.currentPeriodEnd.toISOString(),
          cancelledAt: now.toISOString(),
          cancelledByApprovalId: v.approvalId,
        };
        const [after] = await tx
          .update(schema.subscriptions)
          .set({
            status: "cancelled",
            metadata: sql`coalesce(${schema.subscriptions.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
            updatedAt: now,
          })
          .where(eq(schema.subscriptions.id, before.id))
          .returning();
        await recordAudit(tx, organisationId, {
          actorKind: "user", actorId: v.actorId, action: "subscription.cancelled",
          targetType: "subscription", targetId: before.id, before, after,
        });
        cancelled = true;
      }
    }

    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: `subscription.change_${decision}`,
      targetType: "subscription", targetId: payload.subscriptionId, before: approval, after: claimed,
    });
    await recordActivity(tx, organisationId, {
      clientId: payload.clientId, actorKind: "user", actorId: v.actorId, kind: `subscription.change_${decision}`,
      title: `Plan change ${decision === "approved" ? "approved" : "declined"}: ${SUBSCRIPTION_CHANGE_LABEL[payload.kind].toLowerCase()}`,
      ...(cancelled ? { body: `Subscription cancelled at the end of the current period.` } : {}),
      link: `/clients/${payload.clientId}?tab=contacts`,
    });

    const notices: (typeof schema.messages.$inferSelect)[] = [];
    if (recipients.length > 0) {
      // A conversation of its own, closed from the start: it is the record of
      // what we told the client, not a thread anybody needs to answer.
      const [conversation] = await tx.insert(schema.conversations).values({
        organisationId,
        clientId: payload.clientId,
        subject: `Your plan change request: ${SUBSCRIPTION_CHANGE_LABEL[payload.kind].toLowerCase()}`,
        channel: "portal",
        status: "closed",
        lastMessageAt: now,
      }).returning();
      const body = noticeBody(decision, payload, approval.decisionNote);
      for (const to of recipients) {
        const [notice] = await tx.insert(schema.messages).values({
          organisationId,
          conversationId: conversation!.id,
          direction: "outbound",
          authorKind: "system",
          authorId: null,
          body,
          fromEmail: from,
          toEmail: to,
          subject: decision === "approved" ? "Your request has been approved" : "Your request has been declined",
          status: "queued",
          metadata: { kind: SUBSCRIPTION_CHANGE_NOTICE_KIND, decision, approvalId: v.approvalId },
        }).returning();
        await recordAudit(tx, organisationId, {
          actorKind: "system", action: "message.queued", targetType: "message", targetId: notice!.id, after: notice,
        });
        notices.push(notice!);
      }
    }

    return { cancelled, notices };
  });

  if (!applied) {
    return {
      decision, kind: payload.kind, clientId: payload.clientId, subscriptionId: payload.subscriptionId,
      cancelled: false, notices: [], alreadyApplied: true,
    };
  }

  // After commit: the worker must never be handed an id the transaction rolled back.
  for (const notice of applied.notices) {
    await emit({ name: "message.queued", organisationId, messageId: notice.id });
  }

  return {
    decision, kind: payload.kind, clientId: payload.clientId, subscriptionId: payload.subscriptionId,
    cancelled: applied.cancelled, notices: applied.notices, alreadyApplied: false,
  };
}
