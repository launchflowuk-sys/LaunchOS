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
    const file = `${randomUUID()}${extname(label)}`;
    await writeFile(join(dir, file), bytes);
    stored.push({ name: label, contentType: raw.contentType, size: bytes.byteLength, url: `/api/attachments/${organisationId}/${file}` });
  }
  return stored;
}
