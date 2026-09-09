import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsCheckoutSession } from "@launchos/integrations";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { attachPaymentAccount } from "../billing/payment-accounts.js";
import { recordSubscription } from "../billing/record-subscription.js";
import { notifyOwner } from "../notifications/notify.js";
import { listTaskTemplates } from "../packages/list-task-templates.js";
import { createProject } from "../projects/crud.js";
import { PORTAL_PURCHASE_MARKER } from "./start-purchase.js";

/**
 * Files a completed portal purchase, and starts the work.
 *
 * The same job as `completeProposalCheckout`, for the other door in, and
 * deliberately the same shape: check the marker, check the tenancy, refuse
 * anything not actually paid, claim the work once, then link the customer,
 * record the subscription and start the project.
 *
 * **Idempotent by a conditional UPDATE** on `confirmed_at IS NULL`, not by a
 * read-then-write. Stripe redelivers, and the success redirect races the
 * webhook: of two arrivals exactly one claims the row and the other answers
 * `alreadyRecorded` having written nothing. Without that a client who
 * refreshed the success page would get two projects and two notifications.
 *
 * A trial counts as confirmed. Stripe reports `no_payment_required` for a
 * subscription that starts in trial, and treating that as "not paid" would
 * leave a client who had signed up looking at nothing happening.
 */

export const PURCHASE_PAID_NOTIFICATION_KIND = "purchase.paid";

const PortalPurchaseMetadata = z.object({
  launchos: z.literal(PORTAL_PURCHASE_MARKER),
  organisationId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  clientId: z.string().uuid(),
  packageId: z.string().uuid(),
});

export interface CompletePortalPurchaseResult {
  purchaseId: string;
  clientId: string;
  projectId: string | null;
  subscriptionId: string | null;
  trialing: boolean;
  /** True when this session had already been filed; nothing was touched. */
  alreadyRecorded: boolean;
}

export class PurchaseNotLive extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseNotLive";
  }
}

export async function completePortalPurchase(
  db: Db,
  organisationId: string,
  session: PaymentsCheckoutSession,
): Promise<CompletePortalPurchaseResult> {
  const meta = PortalPurchaseMetadata.safeParse(session.metadata);
  if (!meta.success) throw new PurchaseNotLive("This Checkout session is not a LaunchOS portal purchase.");
  if (meta.data.organisationId !== organisationId) {
    throw new PurchaseNotLive("This payment belongs to another organisation.");
  }
  if (session.status !== "complete") throw new PurchaseNotLive("Payment has not completed yet.");
  // `no_payment_required` is what a trial reports, and it is a yes.
  if (session.paymentStatus === "unpaid") throw new PurchaseNotLive("Payment has not completed yet.");

  const trialing = session.paymentStatus === "no_payment_required";
  const now = new Date();

  // The claim. One statement, so it cannot half-succeed, and the `confirmed_at
  // IS NULL` predicate is what makes a redelivery a no-op instead of a repeat.
  const [claimed] = await db.update(schema.portalPurchases)
    .set({
      status: trialing ? "trialing" : "paid",
      confirmedAt: now,
      stripeSessionId: session.id,
      stripeCustomerId: session.customerId ?? null,
      stripeSubscriptionId: session.subscriptionId ?? null,
      updatedAt: now,
    })
    .where(and(
      eq(schema.portalPurchases.id, meta.data.purchaseId),
      eq(schema.portalPurchases.organisationId, organisationId),
      isNull(schema.portalPurchases.confirmedAt),
    ))
    .returning();

  if (!claimed) {
    const [current] = await db.select().from(schema.portalPurchases)
      .where(and(
        eq(schema.portalPurchases.id, meta.data.purchaseId),
        eq(schema.portalPurchases.organisationId, organisationId),
      ));
    if (!current) throw new PurchaseNotLive("That purchase could not be found.");
    return {
      purchaseId: current.id,
      clientId: current.clientId,
      projectId: current.projectId,
      subscriptionId: null,
      trialing: current.status === "trialing",
      alreadyRecorded: true,
    };
  }

  const clientId = claimed.clientId;

  if (session.customerId) {
    await attachPaymentAccount(db, organisationId, {
      clientId,
      customerId: session.customerId,
      ...(session.customerEmail ? { email: session.customerEmail } : {}),
      actorKind: "system",
    });
  }

  const subscriptionId = await recordSubscription(db, organisationId, {
    clientId,
    packageId: claimed.packageId,
    stripeSubscriptionId: session.subscriptionId ?? null,
    sessionId: session.id,
    now,
  });

  const projectId = await startPurchasedWork(db, organisationId, claimed.id, clientId, claimed.packageId, now);

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "portal_purchase.confirmed",
    targetType: "portal_purchase", targetId: claimed.id,
    after: { sessionId: session.id, subscriptionId, projectId, trialing },
  });
  await recordActivity(db, organisationId, {
    clientId, actorKind: "client", kind: "purchase.paid",
    title: trialing ? "Started a free trial from the portal" : "Bought a service from the portal",
    ...(projectId ? { link: `/projects/${projectId}` } : {}),
  });
  await notifyOwner(db, organisationId, {
    kind: PURCHASE_PAID_NOTIFICATION_KIND,
    title: trialing ? "A client started a trial" : "A client bought a service",
    body: subscriptionId ? "The subscription is running and filed under them." : "The one-off payment is in.",
    link: projectId ? `/projects/${projectId}` : `/clients/${clientId}`,
  });

  return { purchaseId: claimed.id, clientId, projectId, subscriptionId, trialing, alreadyRecorded: false };
}

/**
 * The work they just bought, as a project.
 *
 * A project rather than loose onboarding tasks, because that is what an
 * accepted proposal produces and the client's Progress page is built to read
 * it. Milestones come from the package's own onboarding task templates —
 * configuration Shoji already maintains per package — so a purchase produces a
 * plan that matches what that package actually involves, rather than an empty
 * shell somebody has to fill in later.
 *
 * `generateOnboardingTasks` is deliberately *not* used. It resolves templates
 * from `clients.package_id` and dedupes by `(client_id, template_id)`, so a
 * client buying a second package would get the first package's templates, and
 * nearly all of them skipped as already generated — the purchase would appear
 * to do nothing at all.
 */
async function startPurchasedWork(
  db: Db,
  organisationId: string,
  purchaseId: string,
  clientId: string,
  packageId: string,
  now: Date,
): Promise<string | null> {
  const [pkg] = await db
    .select({ name: schema.packages.name, description: schema.packages.description })
    .from(schema.packages)
    .where(and(eq(schema.packages.id, packageId), eq(schema.packages.organisationId, organisationId)));
  if (!pkg) return null;

  const templates = await listTaskTemplates(db, organisationId, {
    phase: "onboarding",
    packageId,
    includeGlobal: true,
  });

  const created = await createProject(db, organisationId, {
    clientId,
    name: pkg.name,
    ...(pkg.description ? { summary: pkg.description } : {}),
    // Active, not planned: they have just paid and the clock is running. The
    // same call the accepted-proposal job makes, for the same reason.
    status: "active",
    milestones: templates.map((template, index) => ({
      title: template.title,
      phaseKey: "build" as const,
      sort: index,
      clientVisible: true,
    })),
    actorKind: "system",
    now,
  });

  await db.update(schema.portalPurchases)
    .set({ projectId: created.project.id, updatedAt: now })
    .where(and(
      eq(schema.portalPurchases.id, purchaseId),
      eq(schema.portalPurchases.organisationId, organisationId),
    ));

  return created.project.id;
}
