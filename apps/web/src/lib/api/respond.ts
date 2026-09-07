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
  | "rate_limited"
  | "bad_request"
  | "server_error";

const STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthorised: 401,
  forbidden: 403,
  not_found: 404,
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

export function apiError(code: ApiErrorCode, message: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: { code, message } }, {
    status: STATUS[code],
    headers: { "cache-control": "no-store", ...headers },
  });
}
