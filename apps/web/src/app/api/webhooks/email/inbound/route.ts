import { timingSafeEqual } from "node:crypto";
import { schema } from "@launchos/db";
import { normalizeInbound, storeInboundAttachments, type InboundProvider } from "@launchos/channels";
import { emit } from "@launchos/core";
import { asc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const PROVIDERS: readonly InboundProvider[] = ["postmark", "cloudflare", "generic"];
const SECRET_HEADER = "x-launchos-inbound-secret";
// Headroom over storeInboundAttachments' own 10MB-per-file cap: base64
// inflates bytes by roughly a third, and a message can carry more than one
// attachment. This is a defensive ceiling on the whole request body, not a
// precise budget.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** Constant-time compare that does not leak the expected length. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveProvider(url: URL): InboundProvider {
  const requested = url.searchParams.get("provider") ?? process.env.INBOUND_EMAIL_PROVIDER ?? "generic";
  return PROVIDERS.includes(requested as InboundProvider) ? (requested as InboundProvider) : "generic";
}

/**
 * Resolves the organisation from the recipient's support address. With no
 * match, the oldest active organisation owns the mail — the single-tenant v1
 * rule — and the ingest job files it under that organisation's `unmatched`
 * holding client.
 */
async function resolveOrganisationId(to: string[]): Promise<string | null> {
  const db = getDb();
  const [identity] = await db
    .select({ organisationId: schema.emailIdentities.organisationId })
    .from(schema.emailIdentities)
    .where(inArray(schema.emailIdentities.address, to));
  if (identity) return identity.organisationId;
  const [org] = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  return org?.id ?? null;
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get(SECRET_HEADER), process.env.INBOUND_EMAIL_SECRET)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  // Every server entry point that emits a domain event installs the web's
  // pg-boss forwarder first (see apps/web/src/lib/queue.ts) — without this,
  // emit() below is a silent no-op and the message is dropped.
  installWebEnqueue();

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const provider = resolveProvider(new URL(request.url));
  let normalised;
  try {
    normalised = normalizeInbound(provider, payload);
  } catch (err) {
    // A malformed payload is the provider's problem, not something to retry.
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid payload" }, { status: 422 });
  }

  try {
    const organisationId = await resolveOrganisationId(normalised.to);
    if (!organisationId) return NextResponse.json({ error: "no organisation to receive this mail" }, { status: 404 });

    // Attachments are written to disk here so the queue payload stays small;
    // every database write happens in the worker.
    const attachments = await storeInboundAttachments(organisationId, normalised.attachments);
    await emit({ name: "email.received", organisationId, inbound: { ...normalised, attachments } });

    return NextResponse.json({ queued: true, messageId: normalised.messageId }, { status: 202 });
  } catch (err) {
    // Database and filesystem failures here can carry driver-specific detail
    // (host, credentials, paths) — never forward that to the caller.
    console.error("[inbound email webhook] failed to process message", err);
    return NextResponse.json({ error: "failed to process message" }, { status: 500 });
  }
}
