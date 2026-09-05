import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the secrets we hold on a client's behalf — today
 * the per-site WordPress application passwords in `site_credentials`.
 *
 * AES-256-GCM, not AES-CBC or a bare cipher: the authentication tag is what
 * makes a tampered ciphertext *fail* instead of decrypting to garbage that some
 * caller then sends to a live WordPress as a password. Every read verifies it,
 * and `decryptSecret` throws rather than returning a best effort.
 *
 * The key is a server-side secret in the environment and nowhere else. There is
 * deliberately no fallback key, no derived-from-something default and no
 * "encrypt with a random key if none is set" path: a secret store that silently
 * works without its key is a plaintext store with extra steps, and the writes
 * that depend on it refuse to run instead (`loadEncryptionKey` throws).
 */

/** The one environment variable this module reads. 32 random bytes, base64. */
export const SECRETS_ENCRYPTION_KEY_ENV = "SECRETS_ENCRYPTION_KEY";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Envelope prefix, so a future algorithm change can be told apart on read. */
const VERSION = "v1";
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** The key is missing or not 32 bytes of base64. Refuses the write; never falls back. */
export class SecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsKeyError";
  }
}

/** The envelope is malformed, or its authentication tag does not verify. */
export class SecretsDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsDecryptError";
  }
}

/**
 * A 32-byte key from its base64 text. Rejects anything else by length rather
 * than trusting `Buffer.from(…, "base64")`, which silently truncates junk.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new SecretsKeyError(
      `${SECRETS_ENCRYPTION_KEY_ENV} is not set. Generate one with ` +
        `\`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"\`.`,
    );
  }
  if (!BASE64.test(value)) {
    throw new SecretsKeyError(`${SECRETS_ENCRYPTION_KEY_ENV} is not base64.`);
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== KEY_BYTES) {
    throw new SecretsKeyError(
      `${SECRETS_ENCRYPTION_KEY_ENV} must decode to ${KEY_BYTES} bytes, got ${key.byteLength}.`,
    );
  }
  return key;
}

/** True when a usable key is configured. Never throws — for read-only UI checks. */
export function isEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    parseEncryptionKey(env.SECRETS_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The configured key, or a `SecretsKeyError` naming what is wrong with it. */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseEncryptionKey(env.SECRETS_ENCRYPTION_KEY);
}

/**
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64.
 *
 * The iv is random per call, so encrypting the same password twice produces
 * two different envelopes — a row's ciphertext never reveals that two sites
 * share a password.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(".");
}

/** The plaintext, or a `SecretsDecryptError` when the envelope does not verify. */
export function decryptSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretsDecryptError("secret envelope is not a v1 envelope");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const body = Buffer.from(parts[3]!, "base64");
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new SecretsDecryptError("secret envelope has a malformed iv or tag");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately not the underlying message: it varies by Node version and
    // says nothing the caller can act on beyond "this did not verify".
    throw new SecretsDecryptError("secret failed to decrypt — wrong key, or the stored value was altered");
  }
}
