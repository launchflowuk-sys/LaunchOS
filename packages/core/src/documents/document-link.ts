import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { appUrl } from "../config.js";
import { loadEncryptionKey } from "../secrets/encryption.js";

/**
 * The private link a document is read through.
 *
 * `/api/assets/<uuid>` is public by design: Facebook and WordPress fetch a
 * post's image with no cookie, so the uuid is the access control. A document
 * is a priced proposal, a signed acceptance or an invoice — the opposite
 * problem. It is emailed to one named person, forwarded by them without a
 * thought, and must stop working. So:
 *
 * - **The link carries a signature, not just an id.** A guessed or enumerated
 *   uuid is worth nothing without it, and the organisation is inside the
 *   signed payload, so a token minted for one tenant cannot open another
 *   tenant's document even if the two ids were swapped.
 * - **It expires.** Seven days by default (below), and the expiry is signed
 *   too, so a recipient cannot extend their own link by editing the query
 *   string.
 * - **The key is derived, not configured.** There is no `DOCUMENT_LINK_SECRET`
 *   to add to Coolify, forget, and leave defaulted. It is HKDF-SHA256 over
 *   `SECRETS_ENCRYPTION_KEY` — a secret production already requires, already
 *   validates as 32 bytes, and already refuses to start without — with a
 *   domain-separation label so this key and the vault's encryption key are
 *   unrelated values. Rotating `SECRETS_ENCRYPTION_KEY` invalidates every
 *   outstanding link, which is the correct behaviour for a key rotation.
 *
 * The signed link is *one* of three ways in. The owner reads a document
 * through their admin session and the owning client through their portal
 * session, both in `read-document.ts`; neither needs a token. This module is
 * only for the link that leaves the building.
 */

/** The route that serves a document. Not `/api/assets`, which is public. */
export const DOCUMENT_ROUTE_PATH = "/api/documents";
/** The query parameter the token travels in. */
export const DOCUMENT_TOKEN_PARAM = "t";

/**
 * A week.
 *
 * Long enough that a client who opens the email on Friday and comes back to it
 * after the weekend still has a working link, and that a proposal is readable
 * for as long as anyone is likely to be deciding on it. Short enough that a
 * forwarded email is dead paper within days. Callers that want less — a
 * one-off download from an admin screen — pass their own `ttlSeconds`.
 */
export const DEFAULT_DOCUMENT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Thirty days. Past this, use the portal, which authenticates the reader. */
export const MAX_DOCUMENT_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

const VERSION = "v1";
const KEY_INFO = "launchos.document-link.v1";
const KEY_BYTES = 32;

/**
 * The signing key for document links.
 *
 * HKDF rather than using `SECRETS_ENCRYPTION_KEY` itself: the same 32 bytes
 * must not be both an AES key and an HMAC key. The `info` label is what makes
 * this key independent of any other key derived from the same secret later.
 * Throws a `SecretsKeyError` when the secret is unset or malformed — the same
 * refusal, with the same message naming the variable, as the vault.
 */
export function documentLinkKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return Buffer.from(hkdfSync("sha256", loadEncryptionKey(env), Buffer.alloc(0), KEY_INFO, KEY_BYTES));
}

/** What the signature covers. Every field a forger would want to change. */
function payload(organisationId: string, documentId: string, expiresAtSeconds: number): string {
  return `${VERSION}|${organisationId}|${documentId}|${expiresAtSeconds}`;
}

function sign(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export interface SignDocumentLinkInput {
  organisationId: string;
  documentId: string;
  /** Seconds. Clamped to `MAX_DOCUMENT_LINK_TTL_SECONDS`. */
  ttlSeconds?: number;
  /** Injected by the tests; production always means "now". */
  now?: Date;
}

/**
 * `v1.<expiry>.<signature>` — the opaque token the URL carries.
 *
 * The document id is not repeated in the token because it is already in the
 * path; it *is* in the signed payload, so a token cannot be moved from one
 * document's URL to another's.
 */
export function signDocumentToken(input: SignDocumentLinkInput, env: NodeJS.ProcessEnv = process.env): string {
  const ttl = Math.min(Math.max(Math.round(input.ttlSeconds ?? DEFAULT_DOCUMENT_LINK_TTL_SECONDS), 60), MAX_DOCUMENT_LINK_TTL_SECONDS);
  const expires = Math.floor((input.now?.getTime() ?? Date.now()) / 1000) + ttl;
  const signature = sign(payload(input.organisationId, input.documentId, expires), documentLinkKey(env));
  return `${VERSION}.${expires}.${signature}`;
}

/** The absolute URL to put in an email. Signed, expiring, and no session needed. */
export function signedDocumentUrl(input: SignDocumentLinkInput, env: NodeJS.ProcessEnv = process.env): string {
  const token = signDocumentToken(input, env);
  return `${appUrl(env)}${DOCUMENT_ROUTE_PATH}/${input.documentId}?${DOCUMENT_TOKEN_PARAM}=${token}`;
}

export type DocumentTokenRefusal = "malformed" | "expired" | "bad_signature";
export type DocumentTokenResult = { ok: true; expiresAt: Date } | { ok: false; reason: DocumentTokenRefusal };

const Token = z.string().min(1).max(400);

/**
 * Verifies a token against the document and organisation it was minted for.
 *
 * The order matters: shape, then expiry, then signature. A caller that
 * checked the signature first would spend an HMAC on every piece of junk sent
 * at the route; a caller that checked expiry *after* would be no less correct
 * but no faster. The comparison itself is `timingSafeEqual` on two equal-length
 * digests — the standard defence against learning a valid signature one byte
 * at a time, and cheap enough that there is no reason not to.
 */
export function verifyDocumentToken(
  input: { organisationId: string; documentId: string; token: string; now?: Date },
  env: NodeJS.ProcessEnv = process.env,
): DocumentTokenResult {
  if (!Token.safeParse(input.token).success) return { ok: false, reason: "malformed" };
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= 0) return { ok: false, reason: "malformed" };

  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (expires <= nowSeconds) return { ok: false, reason: "expired" };

  const expected = Buffer.from(sign(payload(input.organisationId, input.documentId, expires), documentLinkKey(env)), "utf8");
  const given = Buffer.from(parts[2]!, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and a wrong length is
  // already a wrong signature — the check is not a shortcut, it is what keeps
  // a malformed token from becoming a 500.
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, expiresAt: new Date(expires * 1000) };
}
