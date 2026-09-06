import { timingSafeEqual } from "node:crypto";
import { createLead } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { publicFormsToken } from "@/lib/env";
import { publicOrganisationId } from "@/lib/public-organisation";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { limiter, MAX_BODY_BYTES, PublicLeadBody, TOKEN_HEADER } from "./intake";

export const dynamic = "force-dynamic";

/** Constant-time compare that does not leak the expected length. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The website contact form's webhook. Unauthenticated apart from the shared
 * token, so it is the one place in this app that writes on a stranger's say
 * so — hence the token, the body cap, the per-address limit and a Zod body
 * that trusts nothing. The lead lands on the single active organisation and
 * rings the owner's bell (`lead.created` is urgent: it reaches the phone).
 */
export async function POST(request: Request): Promise<Response> {
  const expected = publicFormsToken();
  if (!expected) {
    // Unset means switched off, not open: say so plainly so a form wired up
    // before the variable is set fails visibly in the plugin's log.
    return NextResponse.json({ error: "lead intake is not configured (PUBLIC_FORMS_TOKEN is unset)" }, { status: 503 });
  }
  if (!tokenMatches(request.headers.get(TOKEN_HEADER), expected)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const address = clientAddress(request);
  if (!limiter.allow(address)) {
    return NextResponse.json(
      { error: "too many enquiries from this address; try again later" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds(address)) } },
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "payload too large" }, { status: 413 });

  let raw: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "payload too large" }, { status: 413 });
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const parsed = PublicLeadBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid lead" }, { status: 400 });
  }
  const body = parsed.data;

  const organisationId = await publicOrganisationId();
  if (!organisationId) return NextResponse.json({ error: "no active organisation" }, { status: 503 });

  // The owner's bell may fan out to a device (`push.requested`), which the
  // web process routes onto pg-boss only once the enqueue is installed.
  installWebEnqueue();
  try {
    const lead = await createLead(getDb(), organisationId, {
      name: body.name,
      ...(body.email ? { email: body.email } : {}),
      ...(body.phone ? { phone: body.phone } : {}),
      ...(body.business ? { business: body.business } : {}),
      ...(body.message ? { message: body.message } : {}),
      source: body.source,
      metadata: { ...(body.page ? { page: body.page } : {}), address },
      actorKind: "client",
    });
    return NextResponse.json({ ok: true, id: lead.id });
  } catch (error) {
    console.error("[public/leads] could not record the lead", { error });
    return NextResponse.json({ error: "the enquiry could not be saved; try again" }, { status: 500 });
  }
}
