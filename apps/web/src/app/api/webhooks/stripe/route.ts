import { findOrganisationByStripeCustomer } from "@launchos/core";
import { createPaymentsAdapter } from "@launchos/integrations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { sendJob } from "@/lib/queue";

export const dynamic = "force-dynamic";

/**
 * Stripe signs the exact bytes it sent, so the body is read as text and
 * passed to the adapter unparsed rather than through `request.json()`. This
 * route only verifies, resolves tenancy and enqueues — every write happens in
 * the worker's `payments.webhook` consumer (ARCHITECTURE.md, job flow).
 */
const CustomerRef = z.object({ object: z.object({ customer: z.string() }).passthrough() });

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });

  const rawBody = await request.text();
  let providerEvent;
  try {
    providerEvent = createPaymentsAdapter(process.env).webhookVerify(rawBody, signature);
  } catch {
    // Never echo the verification error: it would tell an attacker how close
    // their forgery got.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const parsed = CustomerRef.safeParse(providerEvent.data);
  if (!parsed.success) return NextResponse.json({ ok: true, ignored: "no customer on event" });

  // The event carries no LaunchOS tenancy of its own — the Stripe customer id
  // is the only link back to an organisation, resolved through
  // billing_profiles.stripe_customer_id. An event for a customer we have
  // never linked (a different Stripe account, a stale test event) is
  // acknowledged and dropped rather than retried forever.
  const owner = await findOrganisationByStripeCustomer(getDb(), parsed.data.object.customer);
  if (!owner) return NextResponse.json({ ok: true, ignored: "unknown customer" });

  await sendJob(
    "payments.webhook",
    { organisationId: owner.organisationId, providerEvent },
    { singletonKey: `stripe:${providerEvent.id}` },
  );
  return NextResponse.json({ ok: true });
}
