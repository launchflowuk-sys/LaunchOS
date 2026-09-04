import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RawAttachment, StoredAttachment } from "../email/inbound.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.STORAGE_DIR ?? "./storage";
}

/**
 * `basename` on an attacker-supplied name, then a generated file name on disk:
 * the original is only ever shown as a label, never used as a path segment.
 */
function safeName(name: string): string {
  const base = basename(name.replaceAll("\\", "/")).replaceAll("..", "");
  return base.length > 0 ? base.slice(0, 200) : "attachment";
}

/**
 * The extensions that may be copied from an attacker-supplied name onto the
 * generated file name: a dot, then one to ten letters or digits, lowercased.
 *
 * `extname` copies everything after the last dot **verbatim**, and `safeName`
 * above only removes path separators and `..`. So an attachment named
 *
 *     a.pdf"; filename*=UTF-8''setup%2Eexe
 *
 * — which anyone able to send mail to a client's support address can choose —
 * passed straight through and became the stored file's suffix, quote and all.
 * `GET /api/attachments/[org]/[file]` then puts that name in a
 * `content-disposition` header, where RFC 6266 gives the injected `filename*`
 * precedence over the real `filename` and the browser saves the attachment
 * under a name of the sender's choosing. Anything that is not a plain
 * extension is dropped instead; the readable name still survives in
 * `stored.name`, which is what the UI shows.
 */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/i;

/** A plain, lowercased extension for the generated name, or none at all. */
export function safeExtension(label: string): string {
  const ext = extname(label);
  return SAFE_EXTENSION.test(ext) ? ext.toLowerCase() : "";
}

/**
 * A `content-disposition` value for a stored attachment name.
 *
 * Two filenames, neither of them interpolated raw. `filename` is reduced to
 * characters that cannot end a quoted string or start another parameter, so a
 * name that reaches this function unsanitised cannot forge one; `filename*` is
 * the RFC 5987 form, percent-encoded, which is what browsers actually use. The
 * four characters `encodeURIComponent` leaves alone but RFC 5987's `attr-char`
 * does not allow are encoded by hand.
 *
 * Lives here rather than in the route because it is the other half of
 * `safeExtension`: the name is generated in this module and read back in that
 * one, and the two rules have to agree.
 */
export function attachmentContentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function storeInboundAttachments(
  organisationId: string,
  attachments: RawAttachment[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredAttachment[]> {
  if (attachments.length === 0) return [];
  const dir = join(storageRoot(env), "attachments", organisationId);
  await mkdir(dir, { recursive: true });
  const stored: StoredAttachment[] = [];
  for (const raw of attachments) {
    const bytes = Buffer.from(raw.contentBase64, "base64");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`attachment ${raw.name} exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    const label = safeName(raw.name);
    const file = `${randomUUID()}${safeExtension(label)}`;
    await writeFile(join(dir, file), bytes);
    stored.push({ name: label, contentType: raw.contentType, size: bytes.byteLength, url: `/api/attachments/${organisationId}/${file}` });
  }
  return stored;
}
