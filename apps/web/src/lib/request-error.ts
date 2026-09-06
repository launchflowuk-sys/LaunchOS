/**
 * The pure half of `onRequestError` (`src/instrumentation.ts`): what makes
 * two server errors "the same", and which ones are not errors at all. Kept
 * free of `@launchos/core` so it can be tested without a database and so the
 * Edge compilation of the instrumentation file can import it safely.
 */

/** The shape Next hands `onRequestError`; only the fields read here. */
export type RequestErrorContext = {
  routePath: string;
  routeType: string;
  routerKind?: string;
};

export type RequestErrorReport = {
  /** `<route file>:<error class>` — the throttle key `noteSystemError` counts by. */
  signature: string;
  message: string;
  details: Record<string, unknown>;
};

/** `noteSystemError` caps a signature at 200 characters; leave room for the error name. */
const MAX_ROUTE_LENGTH = 150;

/**
 * Next signals `redirect()` and `notFound()` by throwing, and marks those
 * throws with a digest. They never reach `onRequestError` in practice, but a
 * React-processed error can carry the digest instead of the original class,
 * so the guard is on the digest rather than on the name.
 */
export function isControlFlowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("digest" in error)) return false;
  const digest = String((error as { digest: unknown }).digest);
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "NEXT_HTTP_ERROR_FALLBACK";
}

/** What to tell the owner about a request that blew up, or null when it is not worth a notification. */
export function describeRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: RequestErrorContext,
): RequestErrorReport | null {
  if (isControlFlowError(error)) return null;
  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error && error.message ? error.message : String(error);
  const route = context.routePath.slice(0, MAX_ROUTE_LENGTH) || "unknown";
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : undefined;
  return {
    signature: `${route}:${name}`,
    message: message.slice(0, 2000),
    details: {
      // The path without its query string: a query can carry a search term
      // or a token, and the notification is read by more than one person.
      path: request.path.split("?")[0] ?? request.path,
      method: request.method,
      routeType: context.routeType,
      ...(digest ? { digest } : {}),
    },
  };
}
