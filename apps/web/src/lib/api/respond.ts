import { NextResponse } from "next/server";

/**
 * The shape every `/api/v1` reply takes.
 *
 * The rest of this app answers with a bare `{ error }` and that is right for
 * what those routes are — webhooks and internal endpoints with exactly one
 * caller each, changed in the same commit as the thing that calls them. This
 * is different: there is now a consumer *outside this repository*, written in
 * another language, that cannot be updated in the same breath. It needs a
 * contract, and a contract needs a predictable envelope — one place to look
 * for the payload, one place to look for the failure, and a machine-readable
 * `code` so a client can branch without matching on English.
 *
 * Versioned `/v1/` from the first day for the same reason.
 */

export interface ApiMeta {
  readonly organisationId: string;
  /** When the server built this answer, so a cached or replayed reply is obvious. */
  readonly generatedAt: string;
}

export type ApiErrorCode =
  | "unauthorised"
  | "forbidden"
  | "not_found"
  /** The request is well-formed; the system's current state refuses it. */
  | "conflict"
  | "rate_limited"
  | "bad_request"
  | "server_error";

const STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthorised: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  bad_request: 400,
  server_error: 500,
};

export function apiOk<T>(data: T, meta: ApiMeta, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ data, meta }, {
    // A brief is a snapshot of right now. Anything caching it — a CDN, a
    // client library being clever — turns "what is happening" into "what was
    // happening", which is the one thing it must never quietly become.
    headers: { "cache-control": "no-store", ...headers },
  });
}

/**
 * The work has been accepted, not done.
 *
 * A 200 here would say "your brief is ready" when what happened is "a job is on
 * a queue". The distinction is the whole difference between an assistant that
 * waits a moment and reads the result and one that reports success and moves on.
 */
export function apiAccepted<T>(data: T, meta: ApiMeta): NextResponse {
  return NextResponse.json({ data, meta }, { status: 202, headers: { "cache-control": "no-store" } });
}

export function apiError(code: ApiErrorCode, message: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: { code, message } }, {
    status: STATUS[code],
    headers: { "cache-control": "no-store", ...headers },
  });
}
