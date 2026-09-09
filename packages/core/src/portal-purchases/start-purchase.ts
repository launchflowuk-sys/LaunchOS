import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { getOffering, priceOf } from "./catalogue.js";

/**
 * The row that exists before Stripe does.
 *
 * Writing the purchase first, in `pending`, is what makes the rest of this
 * safe. The session's metadata then carries a `purchaseId` we already own, so
 * completion is a claim on a row rather than a hunt through Stripe: the
 * success redirect and the webhook can both arrive, and exactly one of them
 * does the work.
 *
 * It is also the only way an abandoned checkout is visible at all. A flow that
 * only writes on success cannot tell "nobody wanted it" from "it broke".
 */

/** `metadata.launchos` on the Checkout session — what marks it as a portal purchase. */
export const PORTAL_PURCHASE_MARKER = "portal_purchase";

export const StartPortalPurchaseInput = z.object({
  clientId: z.string().uuid(),
  userId: z.string().min(1).optional(),
  /** The offering's slug, not its id: the portal's URLs are slugs. */
  slug: z.string().trim().min(1),
});
export type StartPortalPurchaseInput = z.input<typeof StartPortalPurchaseInput>;

export class PurchaseRefused extends Error {
  constructor(readonly reason: "not_available" | "not_found", message: string) {
    super(message);
    this.name = "PurchaseRefused";
  }
}

export interface StartedPurchase {
  purchaseId: string;
  packageId: string;
  amountPence: number;
  currency: string;
  trialDays: number;
  isSubscription: boolean;
  /** Stripe metadata for the session, already stringified — Stripe metadata is all strings. */
  metadata: Record<string, string>;
}

export async function startPortalPurchase(
  db: Db,
  organisationId: string,
  input: StartPortalPurchaseInput,
): Promise<StartedPurchase> {
  const v = StartPortalPurchaseInput.parse(input);

  // Re-read the offering rather than trusting anything the browser sent: the
  // price charged must be the price we hold, and an offering switched off
  // between page load and click must not still be sellable.
  const offering = await getOffering(db, organisationId, v.slug);
  if (!offering) throw new PurchaseRefused("not_available", "That service is not available to buy right now.");

  const amountPence = priceOf(offering);
  const [purchase] = await db.insert(schema.portalPurchases).values({
    organisationId,
    clientId: v.clientId,
    userId: v.userId ?? null,
    packageId: offering.id,
    status: "pending",
    amountPence,
    currency: offering.currency,
    trialDays: offering.trialDays,
  }).returning();
  if (!purchase) throw new PurchaseRefused("not_found", "The purchase could not be started.");

  await recordAudit(db, organisationId, {
    actorKind: "client", actorId: v.userId ?? undefined,
    action: "portal_purchase.started",
    targetType: "portal_purchase", targetId: purchase.id,
    after: { packageId: offering.id, amountPence, trialDays: offering.trialDays },
  });

  return {
    purchaseId: purchase.id,
    packageId: offering.id,
    amountPence,
    currency: offering.currency,
    trialDays: offering.trialDays,
    isSubscription: offering.kind === "retainer",
    metadata: {
      launchos: PORTAL_PURCHASE_MARKER,
      organisationId,
      purchaseId: purchase.id,
      clientId: v.clientId,
      packageId: offering.id,
    },
  };
}

/**
 * Records which Checkout session a purchase was opened with.
 *
 * Best-effort on purpose: if this write is lost, completion still finds the
 * row through `metadata.purchaseId`, so a failure here costs the abandoned-
 * checkout view and nothing else. The unique index on `stripe_session_id`
 * means a second purchase can never claim the same session.
 */
export async function attachCheckoutSession(
  db: Db,
  organisationId: string,
  purchaseId: string,
  sessionId: string,
): Promise<void> {
  await db.update(schema.portalPurchases)
    .set({ stripeSessionId: sessionId, updatedAt: new Date() })
    .where(and(
      eq(schema.portalPurchases.id, purchaseId),
      eq(schema.portalPurchases.organisationId, organisationId),
    ));
}

/** Marks a purchase the client walked away from, so `pending` means "still open". */
export async function cancelPortalPurchase(
  db: Db,
  organisationId: string,
  purchaseId: string,
): Promise<void> {
  await db.update(schema.portalPurchases)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(schema.portalPurchases.id, purchaseId),
      eq(schema.portalPurchases.organisationId, organisationId),
      eq(schema.portalPurchases.status, "pending"),
    ));
}
