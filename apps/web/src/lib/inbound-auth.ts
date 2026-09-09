import { timingSafeEqual } from "node:crypto";

/** The header Cloudflare and any generic forwarder can set directly. */
export const SECRET_HEADER = "x-launchos-inbound-secret";

/** Constant-time compare that does not leak the expected length. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The same secret, presented the other way Postmark can present it.
 *
 * Postmark's inbound stream has one field — the webhook URL — and no way to
 * attach a custom header. Its documented way to authenticate an inbound
 * webhook is HTTP Basic credentials embedded in that URL, which arrive here as
 * an `Authorization` header. Accepting only `x-launchos-inbound-secret` meant
 * every Postmark delivery was a 401 and the mail was lost with no trace on our
 * side at all — the provider retries, gives up, and the client's email simply
 * never becomes a ticket.
 *
 * Either half may carry it: `https://launchos:<secret>@host/...` puts it in the
 * password, and some consoles are happier with it as the username. Whichever
 * it is, it is compared in constant time against the same
 * `INBOUND_EMAIL_SECRET`. There is no second credential to manage and nothing
 * new to keep in step.
 */
export function basicAuthMatches(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return secretMatches(decoded, expected);
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  // Both are checked so neither placement is a silent 401, and both go through
  // the constant-time compare rather than `===`.
  return secretMatches(pass, expected) || secretMatches(user, expected);
}

/** True when the caller proved they hold `INBOUND_EMAIL_SECRET`, by either route. */
export function authorised(request: Request): boolean {
  const expected = process.env.INBOUND_EMAIL_SECRET;
  return secretMatches(request.headers.get(SECRET_HEADER), expected)
    || basicAuthMatches(request.headers.get("authorization"), expected);
}
