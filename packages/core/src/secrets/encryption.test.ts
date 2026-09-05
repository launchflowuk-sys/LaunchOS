import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SecretsDecryptError,
  SecretsKeyError,
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  loadEncryptionKey,
  parseEncryptionKey,
} from "./encryption.js";

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString("base64");

describe("secrets encryption", () => {
  it("round-trips a secret through an envelope that never contains the plaintext", () => {
    const secret = "abcd EFGH 1234 ijkl MNOP 5678";
    const envelope = encryptSecret(secret, KEY);

    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain(secret);
    expect(decryptSecret(envelope, KEY)).toBe(secret);
  });

  it("produces a different envelope each time so equal secrets do not look equal", () => {
    const a = encryptSecret("same-password", KEY);
    const b = encryptSecret("same-password", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("round-trips non-ASCII", () => {
    const secret = "pässwörd — £250 · 日本語";
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it("refuses a ciphertext whose body was altered", () => {
    const envelope = encryptSecret("original", KEY);
    const parts = envelope.split(".");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64")].join(".");

    expect(() => decryptSecret(tampered, KEY)).toThrow(SecretsDecryptError);
  });

  it("refuses a ciphertext whose authentication tag was altered", () => {
    const envelope = encryptSecret("original", KEY);
    const parts = envelope.split(".");
    const tag = Buffer.from(parts[2]!, "base64");
    tag[0] = tag[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], tag.toString("base64"), parts[3]].join(".");

    expect(() => decryptSecret(tampered, KEY)).toThrow(SecretsDecryptError);
  });

  it("refuses a ciphertext whose iv was altered", () => {
    const envelope = encryptSecret("original", KEY);
    const parts = envelope.split(".");
    const iv = Buffer.from(parts[1]!, "base64");
    iv[0] = iv[0]! ^ 0xff;
    const tampered = [parts[0], iv.toString("base64"), parts[2], parts[3]].join(".");

    expect(() => decryptSecret(tampered, KEY)).toThrow(SecretsDecryptError);
  });

  it("refuses a malformed envelope and one from another key", () => {
    expect(() => decryptSecret("not-an-envelope", KEY)).toThrow(SecretsDecryptError);
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow(SecretsDecryptError);
    expect(() => decryptSecret("v1.AAAA.BBBB.CCCC", KEY)).toThrow(/malformed iv or tag/);
    expect(() => decryptSecret(encryptSecret("x", KEY), randomBytes(32))).toThrow(SecretsDecryptError);
  });

  it("rejects a key that is missing, not base64, or the wrong length", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(SecretsKeyError);
    expect(() => parseEncryptionKey("  ")).toThrow(/is not set/);
    expect(() => parseEncryptionKey("not base64!!")).toThrow(/is not base64/);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/must decode to 32 bytes/);
    expect(parseEncryptionKey(` ${KEY_B64} `).equals(KEY)).toBe(true);
  });

  it("reports whether the environment is configured without throwing", () => {
    expect(isEncryptionConfigured({})).toBe(false);
    expect(isEncryptionConfigured({ SECRETS_ENCRYPTION_KEY: "too-short" })).toBe(false);
    expect(isEncryptionConfigured({ SECRETS_ENCRYPTION_KEY: KEY_B64 })).toBe(true);
    expect(loadEncryptionKey({ SECRETS_ENCRYPTION_KEY: KEY_B64 }).equals(KEY)).toBe(true);
    expect(() => loadEncryptionKey({})).toThrow(SecretsKeyError);
  });
});
