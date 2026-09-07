import { bearerFrom, verifyApiToken, type PermissionKey } from "@launchos/core";
import { getDb } from "@/lib/db";
import { clientAddress, RateLimiter } from "@/lib/rate-limit";
import { apiError } from "./respond";

export interface ApiCaller {
  readonly tokenId: string;
  readonly organisationId: string;
  readonly name: string;
  readonly scopes: readonly PermissionKey[];
}

export type ApiAuth = { readonly ok: true; readonly caller: ApiCaller } | { readonly ok: false; readonly response: Response };

/**
 * Two limiters, because they are defending against two different things.
 *
 * `failures` is keyed by address and is the one that matters: it is what makes
 * guessing a token pointless. Twenty tries a minute against a 32-byte secret is
 * not a race anyone finishes, and unlike the token limiter it applies to
 * callers who have not proved anything yet.
 *
 * `perToken` is keyed by the token and exists to stop a wedged client — a retry
 * loop in Mr. Green, a cron that fires every second — from putting the database
 * under load. It is generous, because a legitimate assistant asking several
 * follow-up questions in a row is the normal case, not the abusive one.
 *
 * Both are in-process, like the lead form's, and for the same reason: two
 * containers each allow the full budget and a restart forgets everything. That
 * is a real limitation and an acceptable one here — this meters a personal
 * assistant, not a paid API. When tokens are sold, this moves to Postgres.
 */
const failures = new RateLimiter({ limit: 20, windowMs: 60_000 });
const perToken = new RateLimiter({ limit: 120, windowMs: 60_000 });

/**
 * Who is calling, or the reply to send them.
 *
 * Every failure answers **401 with the same body**. A missing header, a
 * malformed token, one that was never issued, one revoked an hour ago and one
 * that expired last week are indistinguishable from outside. Anything else
 * tells the holder of a dead token which kind of dead it is, which is a fact
 * they would otherwise have to find out by asking a person.
 */
export async function authenticateApiRequest(request: Request): Promise<ApiAuth> {
  const address = clientAddress(request);
  const token = bearerFrom(request.headers.get("authorization"));

  if (!token) {
    failures.allow(address);
    return { ok: false, response: unauthorised() };
  }

  if (!failures.allow(address)) {
    return {
      ok: false,
      response: apiError("rate_limited", "too many failed attempts from this address", {
        "retry-after": String(failures.retryAfterSeconds(address)),
      }),
    };
  }

  const verified = await verifyApiToken(getDb(), token);
  if (!verified) return { ok: false, response: unauthorised() };

  if (!perToken.allow(verified.tokenId)) {
    return {
      ok: false,
      response: apiError("rate_limited", "this token is making too many requests", {
        "retry-after": String(perToken.retryAfterSeconds(verified.tokenId)),
      }),
    };
  }

  return { ok: true, caller: verified };
}

/**
 * `WWW-Authenticate` because RFC 7235 requires it on a 401 and a client library
 * is entitled to look for it before deciding this is an auth problem at all.
 */
function unauthorised(): Response {
  return apiError("unauthorised", "a valid bearer token is required", { "www-authenticate": 'Bearer realm="launchos"' });
}

/**
 * Whether this token may read an area, using the permission keys the admin
 * already means (spec point 14 — a second vocabulary would be a second place to
 * get permissions wrong).
 *
 * A token with no scopes can read nothing. That is useless, and useless is the
 * correct default for a credential: the alternative is a token that quietly
 * reads everything because nobody ticked a box.
 */
export function callerMay(caller: ApiCaller, scope: PermissionKey): boolean {
  return caller.scopes.includes(scope);
}

export function forbidden(scope: PermissionKey): Response {
  return apiError("forbidden", `this token does not have the "${scope}" scope`);
}
