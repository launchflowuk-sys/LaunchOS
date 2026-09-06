import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { addMonths, type PaymentsCheckoutSession } from "@launchos/integrations";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { attachPaymentAccount } from "../billing/payment-accounts.js";
import { notifyOwner } from "../notifications/notify.js";
import { PROPOSAL_TARGET_TYPE, ProposalRefused, type ProposalRow } from "./shared.js";

/**
 * The other half of `proposals-accepted.ts`'s payment step: what happens when
 * the client actually pays.
 *
 * The follow-on job opens a Stripe Checkout session stamped with
 * `metadata.launchos = "proposal"` and the ids it will need back. Until this
 * existed the webhook read that marker, failed to recognise it, and answered
 * `{ handled: false, action: "ignored" }` — so a client who paid from an
 * accepted proposal was charged by Stripe and had nothing filed under them in
 * LaunchOS: no customer link, no subscription, and a proposal that still read
 * as unpaid. Everything downstream that asks "is this client paying us"
 * answered no.
 *
 * This is deliberately the same shape as `completeSignup`, because it is the
 * same job for the other door in: check the marker and the tenancy, refuse
 * anything not actually paid, claim the work once, then link the customer,
 * record the subscription and stamp the source row.
 */

/** `metadata.launchos` on the Checkout session — what marks it as a proposal's, not a signup's. */
export const PROPOSAL_CHECKOUT_MARKER = "proposal";

/** `proposals.metadata` — the session whose payment was filed, and when. */
export const CHECKOUT_PAID_SESSION_ID = "checkoutPaidSessionId";
export const CHECKOUT_PAID_AT = "checkoutPaidAt";

export const PROPOSAL_PAID_NOTIFICATION_KIND = "proposal.paid";

/** The Checkout metadata `completeProposalCheckout` reads back. Everything a string: Stripe metadata is. */
const ProposalCheckoutMetadata = z.object({
  launchos: z.literal(PROPOSAL_CHECKOUT_MARKER),
  organisationId: z.string().uuid(),
  proposalId: z.string().uuid(),
  acceptanceId: z.string().uuid(),
  clientId: z.string().uuid().optional(),
  packageId: z.string().uuid().optional(),
});

export const CompleteProposalCheckoutInput = z.object({
  session: z.object({
    id: z.string().min(1),
    status: z.enum(["open", "complete", "expired"]),
    paymentStatus: z.enum(["paid", "unpaid", "no_payment_required"]),
    customerId: z.string().optional(),
    subscriptionId: z.string().optional(),
    customerEmail: z.string().optional(),
    metadata: z.record(z.string(), z.string()),
  }),
});
export type CompleteProposalCheckoutInput = { session: PaymentsCheckoutSession };

export interface CompleteProposalCheckoutResult {
  proposal: ProposalRow;
  clientId: string | null;
  subscriptionId: string | null;
  /** True when this session had already been filed; nothing was touched. */
  alreadyRecorded: boolean;
}

/**
 * Files a paid proposal Checkout session.
 *
 * **Idempotent by session id**, because Stripe redelivers: the claim is one
 * conditional UPDATE on the proposal (`metadata->>'checkoutPaidSessionId' IS
 * NULL`), so of two deliveries arriving together exactly one does the work and
 * the other answers `alreadyRecorded` having written nothing. The claim is on
 * the proposal rather than a separate table for the same reason the signup's
 * claim is on the lead: it is the row the answer belongs to, and one statement
 * cannot half-succeed.
 *
 * The subscription insert is guarded a second time by
 * `subscriptions_org_stripe_id`, so even a hand-replayed event with a fresh
 * session id cannot produce two subscriptions for one Stripe subscription.
 */
export async function completeProposalCheckout(
  db: Db,
  organisationId: string,
  input: CompleteProposalCheckoutInput,
): Promise<CompleteProposalCheckoutResult> {
  const session = CompleteProposalCheckoutInput.parse(input).session as PaymentsCheckoutSession;
  const meta = ProposalCheckoutMetadata.safeParse(session.metadata);
  if (!meta.success) throw new ProposalRefused("not_found", "This Checkout session is not a LaunchOS proposal.");
  if (meta.data.organisationId !== organisationId) {
    throw new ProposalRefused("not_found", "This payment belongs to another organisation.");
  }
  if (session.status !== "complete" || session.paymentStatus === "unpaid") {
    throw new ProposalRefused("not_live", "Payment has not completed yet.");
  }

  const [proposal] = await db.select().from(schema.proposals)
    .where(and(eq(schema.proposals.id, meta.data.proposalId), eq(schema.proposals.organisationId, organisationId)));
  if (!proposal) throw new ProposalRefused("not_found", "That proposal could not be found.");

  const now = new Date();
  const stamp = { [CHECKOUT_PAID_SESSION_ID]: session.id, [CHECKOUT_PAID_AT]: now.toISOString() };
  const [claimed] = await db.update(schema.proposals)
    .set({
      metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
      updatedAt: now,
    })
    .where(and(
      eq(schema.proposals.id, proposal.id),
      eq(schema.proposals.organisationId, organisationId),
      sql`${schema.proposals.metadata}->>${CHECKOUT_PAID_SESSION_ID} is null`,
    ))
    .returning();
  if (!claimed) {
    const [current] = await db.select().from(schema.proposals)
      .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.organisationId, organisationId)));
    return {
      proposal: current ?? proposal,
      clientId: (current ?? proposal).clientId,
      subscriptionId: null,
      alreadyRecorded: true,
    };
  }

  // The proposal's own `client_id` is the authority: acceptance converts the
  // lead and backfills it, and it may have been set after the session's
  // metadata was written. The metadata is the fallback for a session opened
  // before the conversion landed.
  const clientId = claimed.clientId ?? meta.data.clientId ?? null;
  if (clientId && session.customerId) {
    await attachPaymentAccount(db, organisationId, {
      clientId,
      customerId: session.customerId,
      ...(session.customerEmail ? { email: session.customerEmail } : {}),
      actorKind: "system",
    });
  }

  const subscriptionId = clientId
    ? await recordSubscription(db, organisationId, {
      clientId,
      packageId: claimed.packageId ?? meta.data.packageId ?? null,
      stripeSubscriptionId: session.subscriptionId ?? null,
      sessionId: session.id,
      now,
    })
    : null;

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "proposal.paid",
    targetType: PROPOSAL_TARGET_TYPE, targetId: claimed.id,
    before: proposal,
    after: { sessionId: session.id, customerId: session.customerId ?? null, subscriptionId, clientId },
  });
  if (clientId) {
    await recordActivity(db, organisationId, {
      clientId, actorKind: "client", kind: "proposal.paid",
      title: `Payment received for proposal ${claimed.reference}`,
      link: `/proposals/${claimed.id}`,
    });
  }
  await notifyOwner(db, organisationId, {
    kind: PROPOSAL_PAID_NOTIFICATION_KIND,
    title: `${claimed.reference} paid`,
    body: subscriptionId ? "The retainer is running and filed under the client." : "The one-off payment is in.",
    link: `/proposals/${claimed.id}`,
  });

  return { proposal: claimed, clientId, subscriptionId, alreadyRecorded: false };
}

/**
 * The subscription this payment started, when it started one.
 *
 * A `one_off` proposal has no Stripe subscription on its session and gets no
 * row here — a single payment is not a retainer, and inventing a subscription
 * for one would put a client on a plan they never agreed to. The amount comes
 * from the package where there is one, because that is the price the proposal
 * quoted; `importStripeSubscription` corrects it from Stripe's own figures the
 * moment the first `customer.subscription.*` event arrives.
 */
async function recordSubscription(
  db: Db,
  organisationId: string,
  input: { clientId: string; packageId: string | null; stripeSubscriptionId: string | null; sessionId: string; now: Date },
): Promise<string | null> {
  if (!input.stripeSubscriptionId) return null;

  const [pkg] = input.packageId
    ? await db.select({ monthlyPricePence: schema.packages.monthlyPricePence, currency: schema.packages.currency })
      .from(schema.packages)
      .where(and(eq(schema.packages.id, input.packageId), eq(schema.packages.organisationId, organisationId)))
    : [undefined];

  const [row] = await db.insert(schema.subscriptions).values({
    organisationId,
    clientId: input.clientId,
    packageId: input.packageId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    status: "active",
    currentPeriodStart: input.now,
    currentPeriodEnd: addMonths(input.now, 1),
    amountPence: pkg?.monthlyPricePence ?? 0,
    currency: pkg?.currency ?? "GBP",
    metadata: { checkoutSessionId: input.sessionId },
  })
    // The unique `(organisation_id, stripe_subscription_id)` index is the
    // second belt: a replayed event with a new session id still cannot file
    // the same Stripe subscription twice.
    .onConflictDoNothing({ target: [schema.subscriptions.organisationId, schema.subscriptions.stripeSubscriptionId] })
    .returning();

  if (row) {
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "subscription.created",
      targetType: "subscription", targetId: row.id, after: row,
    });
    return row.id;
  }

  const [existing] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions)
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.stripeSubscriptionId, input.stripeSubscriptionId),
    ));
  return existing?.id ?? null;
}
