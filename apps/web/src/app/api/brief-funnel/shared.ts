import { briefSessionBySecret, type BriefSessionRow } from "@launchos/core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";
import { RateLimiter } from "@/lib/rate-limit";

/**
 * The shared parts of the brief funnel's endpoints.
 *
 * Every one of these is public — there is no signed-in user — so they trust
 * nothing: a body cap, a per-address limit, Zod on the way in, and the cookie
 * secret as the only thing that grants access to a draft.
 */

/** The draft's only credential. HttpOnly, so no script on the page can read it. */
export const SESSION_COOKIE = "lf_brief";

/**
 * A questionnaire is a handful of short answers. 64KB is generous for that and
 * small enough that a script cannot use the endpoint to push megabytes into
 * jsonb.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Generous per address, because this is autosave: a person typing through
 * eight screens legitimately makes a lot of small writes. Tight enough that
 * a script cannot open thousands of drafts.
 */
export const funnelLimiter = new RateLimiter({ limit: 600, windowMs: 60_000 });
export const startLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Reads and parses a capped body. Returns null when it is too big or not JSON. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ResolvedSession {
  organisationId: string;
  session: BriefSessionRow;
}

/**
 * The draft behind the request's cookie, or null.
 *
 * Null for a missing cookie, a wrong secret, a deleted draft and an expired
 * one alike. The caller answers all four the same way, and saying which it was
 * would turn this into a way to ask whether a given draft exists.
 */
export async function sessionFromRequest(): Promise<ResolvedSession | null> {
  const organisationId = await publicOrganisationId();
  if (!organisationId) return null;
  const secret = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!secret) return null;
  const session = await briefSessionBySecret(getDb(), organisationId, secret);
  return session ? { organisationId, session } : null;
}

/**
 * Same-origin check for every write.
 *
 * The cookie is `SameSite=Lax`, which already stops a cross-site form post
 * carrying it. This is the second lock: `Origin` is set by the browser on every
 * cross-origin request and cannot be forged by page script, so a mismatch is a
 * request that has no business here regardless of what the cookie says.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Same-origin fetches from some browsers omit Origin entirely; a missing
  // header is not evidence of an attack, and Lax covers that case.
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
