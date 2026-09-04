import { randomBytes } from "node:crypto";

// No 0/O/1/l/I: the password is read off a screen and typed by hand once.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * A one-time password for a newly created staff account. 16 characters from a
 * 56-symbol alphabet is ~93 bits, so the modulo bias of the byte-to-symbol map
 * is irrelevant here; this is not a long-lived secret and is never stored in
 * plain text — only its hash reaches the database.
 */
export function generateOneTimePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
