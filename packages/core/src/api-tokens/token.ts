import { createHash, randomBytes } from "node:crypto";

/**
 * Making and recognising an API token. Pure, so it can be tested without a
 * database and reasoned about without one.
 *
 * The `los_` prefix is not decoration. A token with a known shape can be taught
 * to a secret scanner — GitHub push protection, trufflehog, a pre-commit hook —
 * so one that ends up in a commit or a log line is *findable*. An opaque blob
 * of base64 is not.
 */
const TOKEN_PREFIX = "los_";
/** 32 bytes. Guessing one is not a threat model at this size; losing one is. */
const SECRET_BYTES = 32;
/** Enough of the token to tell two rows apart on screen, far too little to be worth anything. */
const DISPLAY_PREFIX_CHARS = TOKEN_PREFIX.length + 8;

export interface NewToken {
  /** The whole token. Shown once, at issue, and never obtainable again. */
  readonly token: string;
  /** What goes in the database. */
  readonly tokenHash: string;
  /** What a person sees in the list afterwards. */
  readonly prefix: string;
}

export function generateApiToken(): NewToken {
  const token = `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashApiToken(token), prefix: token.slice(0, DISPLAY_PREFIX_CHARS) };
}

/**
 * SHA-256, hex.
 *
 * Not bcrypt or argon2, and that is the considered choice rather than the lazy
 * one. Those algorithms are slow *on purpose*, to make brute force expensive
 * against secrets a human invented and therefore guessable. This secret is 32
 * random bytes — there is no dictionary, no reuse, and no meaningful search
 * space — so a slow hash on every single API call would buy latency and
 * nothing else. GitHub's personal access tokens are stored the same way.
 */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a string is shaped like one of ours.
 *
 * Used to skip the database lookup entirely for something that could never
 * match — a browser sending a session cookie's value, a copied Bearer from
 * somewhere else. Cheap, and it keeps junk out of the query log.
 */
export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > DISPLAY_PREFIX_CHARS;
}

/** The `Authorization: Bearer …` value, or null. Case-insensitive on the scheme, as RFC 7235 requires. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
