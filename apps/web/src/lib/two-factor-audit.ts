import { recordTwoFactorEvent, type TwoFactorEvent } from "@launchos/core";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { getDb } from "./db";

/**
 * Better Auth's own cookie name for a sign-in that has passed the password
 * and is waiting on a code. Its presence *on the request* is how this file
 * tells a sign-in challenge apart from somebody confirming a new enrolment
 * from a screen they are already signed in to: the two hit the same endpoint
 * and return the same shape. Checked on the request rather than the response,
 * because a successful challenge expires the cookie before this hook runs.
 */
const CHALLENGE_COOKIE = "two_factor";

/** The endpoints that produce a security event worth keeping. */
const AUDITED = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);

/** What a successful `verify-*` hands back. Only the id is ever read. */
const VerifiedUser = z.object({ user: z.object({ id: z.string().min(1) }) });

type Middleware = Parameters<typeof createAuthMiddleware>[0];
type HookContext = Parameters<Middleware>[0];

/** Advisory only — a proxy header nobody authenticated. Logged, never trusted. */
function whereFrom(ctx: HookContext) {
  const forwarded = ctx.headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: forwarded || ctx.headers?.get("x-real-ip") || null,
    userAgent: ctx.headers?.get("user-agent") ?? null,
  };
}

/** The signed challenge cookie this request arrived with, if any. */
async function challengeToken(ctx: HookContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(CHALLENGE_COOKIE);
  // `getSignedCookie` answers `false` for a cookie whose signature does not
  // check out, which is a missing challenge as far as this file is concerned.
  return (await ctx.getSignedCookie(cookie.name, ctx.context.secret)) || null;
}

/**
 * Who the pending sign-in belongs to, read back from the verification row the
 * challenge cookie points at.
 *
 * Only ever called on a *failed* attempt, which is the one case where the row
 * is still there: a success consumes it, and so does the fifth wrong code.
 * Null after that fifth one — the account is the thing being protected and
 * there is nothing left to name it by, so the caller logs and files nothing
 * rather than filing an event against a guess.
 */
async function pendingUserId(ctx: HookContext, token: string): Promise<string | null> {
  const row = await ctx.context.internalAdapter.findVerificationValue(token);
  return row?.value ?? null;
}

/**
 * The signed-in user behind a session-authenticated call.
 *
 * Three sources, in the order they survive the handler: the session the
 * endpoint's own middleware resolved, the replacement session Better Auth
 * mints when it rotates one (which is what `/two-factor/disable` leaves
 * behind, having just deleted the old one), and finally the request cookie.
 */
async function sessionUserId(ctx: HookContext): Promise<string | null> {
  const resolved = ctx.context.session?.user?.id ?? ctx.context.newSession?.user?.id;
  if (resolved) return resolved;
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  if (!token) return null;
  return (await ctx.context.internalAdapter.findSession(token))?.user?.id ?? null;
}

/**
 * Decides which of the five events this request was, and who it happened to.
 *
 * Deliberately quiet about two things. A **successful** sign-in challenge is
 * not an event: it happens every time anybody signs in and would bury the
 * four that matter. A code mistyped during enrolment is not one either —
 * there is no live second factor to have failed a challenge against, and the
 * person is already signed in.
 */
async function classify(ctx: HookContext): Promise<{ userId: string; event: TwoFactorEvent } | null> {
  const failed = ctx.context.returned instanceof APIError;
  const path = ctx.path;

  if (path === "/two-factor/disable" || path === "/two-factor/generate-backup-codes") {
    // A wrong password here is a refused sensitive action, not a failed
    // challenge; Better Auth's own rate limiter is what answers that.
    if (failed) return null;
    const userId = await sessionUserId(ctx);
    if (!userId) return null;
    return {
      userId,
      event: path === "/two-factor/disable" ? "disabled" : "backup_codes_regenerated",
    };
  }

  const challenge = await challengeToken(ctx);

  if (failed) {
    if (!challenge) return null;
    const userId = await pendingUserId(ctx, challenge);
    if (!userId) return null;
    return { userId, event: "challenge_failed" };
  }

  const parsed = VerifiedUser.safeParse(ctx.context.returned);
  if (!parsed.success) return null;

  if (path === "/two-factor/verify-backup-code") {
    return { userId: parsed.data.user.id, event: "backup_code_used" };
  }
  // verify-totp, signed in, no challenge in flight: the first correct code
  // after `/two-factor/enable`, which is the moment the factor goes live.
  return challenge ? null : { userId: parsed.data.user.id, event: "enabled" };
}

/**
 * Records every two-factor security event from inside the auth layer.
 *
 * It sits here rather than in the screens that trigger it because the screens
 * are not the only way in: a server action, a stale tab or a hand-rolled POST
 * to `/api/auth` all reach the same endpoints, and an audit trail somebody can
 * skip by not using the form is not an audit trail.
 *
 * A failure to file **never** fails the request. Refusing a sign-in because
 * the log write timed out would turn an audit problem into an outage, and the
 * gap is still visible in `audit_log` by its absence — which is what an
 * integrity review looks for. It is logged with the user on it instead.
 */
export const twoFactorAuditHook = createAuthMiddleware(async (ctx) => {
  if (!AUDITED.has(ctx.path)) return;
  try {
    const outcome = await classify(ctx);
    if (!outcome) return;
    const filed = await recordTwoFactorEvent(getDb(), { ...outcome, ...whereFrom(ctx) });
    if (!filed) {
      console.error("[two-factor] event not filed: user belongs to no organisation", {
        userId: outcome.userId,
        event: outcome.event,
      });
    }
  } catch (error) {
    console.error("[two-factor] security event could not be recorded", { path: ctx.path, error });
  }
});
