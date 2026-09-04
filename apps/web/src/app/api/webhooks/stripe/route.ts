import { findOrganisationByStripeCustomer } from "@launchos/core";
import { QUEUE, dailyDedupe } from "@launchos/core/queue";
import { createPaymentsAdapter, type PaymentsAdapter } from "@launchos/integrations";
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

// Stripe events are kilobytes. This is an unauthenticated endpoint, so the
// body is capped before it is buffered into a string — otherwise a single
// large POST is a free way to spend the container's memory, signature or no
// signature.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * `next dev` re-evaluates this module on recompile, and `StripePaymentsAdapter`
 * constructs a `Stripe` client with its own HTTP agent and connection pool, so
 * building one per request (Stripe retries hard on failure) would discard
 * hundreds of clients and sockets. Cached the way `getDb()` caches its pool.
 */
const globalForPayments = globalThis as typeof globalThis & { __launchosPayments?: PaymentsAdapter };
let cachedAdapter: PaymentsAdapter | undefined;
let warnedNotConfigured = false;

function paymentsAdapter(): PaymentsAdapter {
  const existing = cachedAdapter
    ?? (process.env.NODE_ENV === "production" ? undefined : globalForPayments.__launchosPayments);
  if (existing) {
    cachedAdapter = existing;
    return existing;
  }
  cachedAdapter = createPaymentsAdapter(process.env);
  if (process.env.NODE_ENV !== "production") globalForPayments.__launchosPayments = cachedAdapter;
  return cachedAdapter;
}

/**
 * Fails closed. `createPaymentsAdapter` falls back to the mock adapter when
 * Stripe is not fully configured — a sane default for outbound calls, and a
 * hole behind a public endpoint: the mock accepts the literal signature
 * `"mock"`, so an unconfigured deploy would let anyone forge `invoice.paid`
 * and mark real invoices paid. The mock is never reachable from this route.
 */
function isConfigured(payments: PaymentsAdapter): boolean {
  return payments.name === "stripe" && Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

export async function POST(request: Request) {
  const payments = paymentsAdapter();
  if (!isConfigured(payments)) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(
        "stripe webhook refused: payments adapter is not Stripe. Set PAYMENTS_ADAPTER=stripe, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to enable this endpoint.",
      );
    }
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let providerEvent;
  try {
    providerEvent = payments.webhookVerify(rawBody, signature);
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

  // The key is paired with a dedupe window: the queue policy alone only
  // collapses a duplicate still in flight, and Stripe redelivers an event for
  // days (packages/core/src/queue/queues.ts).
  await sendJob(
    QUEUE.paymentsWebhook,
    { organisationId: owner.organisationId, providerEvent },
    dailyDedupe(`stripe:${providerEvent.id}`),
  );
  return NextResponse.json({ ok: true });
}
