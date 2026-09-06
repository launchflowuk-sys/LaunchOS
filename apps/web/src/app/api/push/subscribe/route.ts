import { removePushSubscription, savePushSubscription } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { PushSubscriptionBody, PushUnsubscribeBody } from "@/lib/push";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A subscription body is a few hundred bytes; a cap well above that stops an
 * unauthenticated caller making the process buffer whatever it likes.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * The signed-in staff member's own device list, and nothing else's.
 *
 * `getSession` rather than `requireAdmin`: this is fetched by script from the
 * account page, and a redirect to `/sign-in` would come back to `fetch` as an
 * HTML page with status 200. A 401 is an answer the caller can act on.
 */
async function authorised() {
  const session = await getSession();
  if (!session) return { session: null, response: NextResponse.json({ error: "sign in first" }, { status: 401 }) };
  return { session, response: null };
}

async function readJson(request: Request): Promise<unknown | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
}

/** Registers this browser for the signed-in member's urgent alerts. */
export async function POST(request: Request): Promise<Response> {
  const { session, response } = await authorised();
  if (!session) return response;

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = PushSubscriptionBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid subscription" }, { status: 400 });

  const userAgent = request.headers.get("user-agent")?.slice(0, 500);
  const row = await savePushSubscription(getDb(), session.organisationId, {
    userId: session.userId,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    ...(userAgent ? { userAgent } : {}),
  });
  return NextResponse.json({ ok: true, id: row.id });
}

/** Takes this browser off the list. Scoped to the member: another user's endpoint is a no-op 404. */
export async function DELETE(request: Request): Promise<Response> {
  const { session, response } = await authorised();
  if (!session) return response;

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = PushUnsubscribeBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid subscription" }, { status: 400 });

  const removed = await removePushSubscription(getDb(), session.organisationId, {
    userId: session.userId,
    endpoint: parsed.data.endpoint,
  });
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
