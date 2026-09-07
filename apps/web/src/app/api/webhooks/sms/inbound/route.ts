import { parseTwilioInbound, stripChannelPrefix, verifyTwilioSignature } from "@launchos/channels";
import { ingestInboundEnquiry } from "@launchos/core";
import { schema } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

/** A text is short. Anything this size is not one, and is not read. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The single-tenant rule the inbound email route already uses: the oldest
 * active organisation owns anything that arrives without a better answer.
 * When a second organisation has its own number, this resolves by `To`.
 */
async function resolveOrganisationId(): Promise<string | null> {
  const [org] = await getDb()
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  return org?.id ?? null;
}

/**
 * Twilio posts a message here.
 *
 * The signature is the whole of the security on this endpoint — the body
 * carries nothing secret, so without verification anyone who learns the URL can
 * post a message and manufacture a lead. It is checked against the raw form
 * fields and the exact URL Twilio called, before anything is parsed or read.
 *
 * Twilio expects TwiML or an empty 200. Replying is not this route's job: the
 * lead it creates raises `lead.created`, the Lead Qualifier drafts Shoji's
 * reply, and he approves it. An automatic answer here would be an outward
 * message no human agreed to, which is the one thing this system does not do.
 */
export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // Refusing is right: unset means this endpoint cannot tell Twilio from
    // anyone else, and an open door here writes leads from strangers.
    console.error("[inbound sms webhook] TWILIO_AUTH_TOKEN is not set; refusing");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

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

  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;

  if (!verifyTwilioSignature(authToken, request.url, params, request.headers.get("x-twilio-signature"))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  installWebEnqueue();

  let inbound;
  try {
    inbound = parseTwilioInbound(params);
  } catch (err) {
    // Signed but malformed is Twilio's problem, and retrying will not fix it.
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid payload" }, { status: 422 });
  }

  try {
    const organisationId = await resolveOrganisationId();
    if (!organisationId) return NextResponse.json({ error: "no organisation to receive this" }, { status: 404 });

    const outcome = await ingestInboundEnquiry(getDb(), organisationId, {
      channel: inbound.channel,
      from: stripChannelPrefix(inbound.from),
      body: inbound.body,
      externalId: inbound.externalId,
      receivedAt: inbound.receivedAt,
    });

    // Twilio treats a 2xx with no TwiML as "received, send nothing".
    return NextResponse.json({ action: outcome.action }, { status: 200 });
  } catch (err) {
    console.error("[inbound sms webhook] failed to process message", err);
    return NextResponse.json({ error: "failed to process message" }, { status: 500 });
  }
}
