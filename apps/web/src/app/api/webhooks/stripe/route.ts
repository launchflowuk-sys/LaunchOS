import { findOrganisationByStripeCustomer, signupOrganisationFromEvent, soleActiveOrganisationId } from "@launchos/core";
import { QUEUE } from "@launchos/core/queue";
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

/**
 * The organisation behind an event's Stripe customer: the customer id is the
 * only link back to a tenant, resolved through billing_profiles.
 * `null` when the event names no customer at all, `undefined` for a customer
 * we have never linked (a different Stripe account, a stale test event) —
 * both are acknowledged and dropped rather than retried forever.
 */
async function organisationForCustomer(data: unknown): Promise<string | null | undefined> {
  const parsed = CustomerRef.safeParse(data);
  if (!parsed.success) return null;
  const owner = await findOrganisationByStripeCustomer(getDb(), parsed.data.object.customer);
  return owner?.organisationId;
}

/**
 * A subscription created in the Stripe dashboard (or by a Payment Link) is
 * for a customer no billing profile knows yet — the very case the Stripe
 * sync provisions a client for. With exactly one active organisation there
 * is only one place it can belong; with two or more nothing is guessed and
 * the event is dropped as an unknown customer, the way it always was.
 */
const SUBSCRIPTION_EVENT = /^customer\.subscription\.(created|updated|deleted)$/;

async function organisationForSubscriptionEvent(eventType: string): Promise<string | undefined> {
  if (!SUBSCRIPTION_EVENT.test(eventType)) return undefined;
  return (await soleActiveOrganisationId(getDb())) ?? undefined;
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

  // A declared length is required, and it must parse. Without this a
  // `Transfer-Encoding: chunked` POST carrying no `content-length` sails past
  // the cap and `request.text()` below buffers the whole stream — the same
  // unauthenticated memory exhaustion the cap exists to stop. An unparseable
  // length is refused rather than waved through for the same reason. Stripe
  // always sends a numeric `content-length`.
  const header = request.headers.get("content-length");
  const contentLength = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    console.warn({ route: "webhooks/stripe", contentLength: header }, "refused webhook: missing or invalid content-length");
    return NextResponse.json({ error: "missing or invalid content-length" }, { status: 411 });
  }
  if (contentLength > MAX_BODY_BYTES) {
    console.warn({ route: "webhooks/stripe", contentLength }, "refused webhook: payload too large");
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

  // A self-serve signup's `checkout.session.completed` is for a brand-new
  // customer with no billing_profiles row yet, so tenancy comes from our own
  // metadata on the session (`launchos: "signup"` + organisationId) before
  // the customer lookup is even tried.
  const byCustomer = signupOrganisationFromEvent(providerEvent) ?? (await organisationForCustomer(providerEvent.data));
  const organisationId = byCustomer === undefined ? await organisationForSubscriptionEvent(providerEvent.type) : byCustomer;
  if (organisationId === null) return NextResponse.json({ ok: true, ignored: "no customer on event" });
  if (organisationId === undefined) return NextResponse.json({ ok: true, ignored: "unknown customer" });

  // A plain key, deliberately: it collapses a burst of identical deliveries
  // while the job is still queued, and nothing more. A `singletonSeconds`
  // window here would also cover `failed`, so a Stripe "Resend" — the only
  // recovery path an event whose sync failed has — would be dropped on insert
  // and answered 200 with nothing enqueued. Redelivery is instead answered by
  // the domain layer: `syncFromPaymentsEvent`'s unique
  // (organisation_id, provider, provider_ref) index returns
  // `{ handled: false, action: "duplicate" }` with the row in front of it.
  await sendJob(
    QUEUE.paymentsWebhook,
    { organisationId, providerEvent },
    { singletonKey: `stripe:${providerEvent.id}` },
  );
  return NextResponse.json({ ok: true });
}
