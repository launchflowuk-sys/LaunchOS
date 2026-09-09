"use server";

import {
  attachCheckoutSession,
  cancelPortalPurchase,
  appUrl,
  createLead,
  getOffering,
  PurchaseRefused,
  startPortalPurchase,
} from "@launchos/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { installWebEnqueue } from "@/lib/queue";
import { requireClient } from "@/lib/portal-session";

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * Buying a service from the portal.
 *
 * The slug is the only thing taken from the form; the price, the trial and
 * whether it is a subscription are all re-read from the package on the server.
 * A form field naming a price would be a form field the browser can edit.
 */
export async function startPurchaseAction(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  const slug = z.string().trim().min(1).safeParse(formData.get("slug"));
  if (!slug.success) return { status: "error", message: "Choose a service first." };

  const db = getDb();
  const payments = getPayments();
  const base = appUrl(process.env);

  let url: string;
  let purchaseId: string;
  try {
    const started = await startPortalPurchase(db, session.organisationId, {
      clientId: session.clientId,
      userId: session.userId,
      slug: slug.data,
    });
    purchaseId = started.purchaseId;

    const offering = await getOffering(db, session.organisationId, slug.data);
    if (!offering) return { status: "error", message: "That service is not available to buy right now." };

    const checkout = await payments.createCheckoutSession({
      // A retainer subscribes to the package's Stripe price; a one-off is a
      // single line built from the price we just recorded on the purchase.
      ...(started.isSubscription && offering.stripePriceId
        ? { priceId: offering.stripePriceId }
        : {
          oneOff: {
            description: offering.name,
            amountPence: started.amountPence,
            currency: started.currency,
          },
        }),
      customerEmail: session.email,
      successUrl: `${base}/portal/services/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/portal/services/${encodeURIComponent(slug.data)}?cancelled=1&purchase=${purchaseId}`,
      clientReference: purchaseId,
      metadata: started.metadata,
    });
    if (!checkout.url) return { status: "error", message: "Could not open the payment page. Please try again." };

    // Best-effort: completion finds the row through the session metadata even
    // if this write is lost, so a failure here costs the abandoned-checkout
    // view and nothing more.
    await attachCheckoutSession(db, session.organisationId, purchaseId, checkout.id);
    url = checkout.url;
  } catch (error) {
    if (error instanceof PurchaseRefused) return { status: "error", message: error.message };
    console.error("[portal] could not start the purchase", { slug: slug.data, error });
    return { status: "error", message: "Something went wrong starting your order. Please try again." };
  }

  redirect(url);
}


/** The client came back from Stripe without paying. */
export async function abandonPurchaseAction(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  const id = z.string().uuid().safeParse(formData.get("purchaseId"));
  if (!id.success) return { status: "ok" };
  await cancelPortalPurchase(getDb(), session.organisationId, id.data);
  return { status: "ok" };
}

const EnquirySchema = z.object({
  summary: z.string().trim().min(1, "Tell us what you are after").max(200),
  detail: z.string().trim().max(4000).optional(),
});

/**
 * Something we do not sell off the shelf — a new website, usually.
 *
 * Lands as a lead with `source: "portal"` rather than a ticket, because it is
 * new business and belongs in the pipeline with everything else. The client is
 * named in the message and carried in metadata so it is obvious this came from
 * somebody we already work with.
 */
export async function submitEnquiryAction(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  const parsed = EnquirySchema.safeParse({
    summary: formData.get("summary"),
    detail: formData.get("detail") ?? undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form and try again" };
  }

  // Creating a lead emits `lead.created`, which the worker turns into the
  // owner's notification; without this the emit is a silent no-op in web.
  installWebEnqueue();
  await createLead(getDb(), session.organisationId, {
    name: session.name,
    email: session.email,
    business: session.clientName,
    message: parsed.data.detail
      ? `${parsed.data.summary}\n\n${parsed.data.detail}`
      : parsed.data.summary,
    source: "portal",
    metadata: { clientId: session.clientId, clientName: session.clientName, via: "portal_services" },
    actorKind: "client",
    actorId: session.userId,
  });

  redirect("/portal/services?enquired=1");
}
