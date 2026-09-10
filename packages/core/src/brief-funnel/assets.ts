import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";

/**
 * Files a customer attaches to their brief: a logo, some photos, an old
 * brochure.
 *
 * Two rules run through all of it.
 *
 * **The bytes decide the type, not the browser.** `Content-Type` and the file
 * extension are both chosen by whoever is uploading. A file called `logo.png`
 * that begins `<script` is not a PNG, and treating it as one is how a stored
 * file becomes a stored XSS the moment something serves it back.
 *
 * **Nothing is "uploaded" until this says so.** A row starts `pending` and only
 * becomes `ready` once the bytes are written and checked, so a half-finished
 * upload can never reach the brief writer or a staff screen looking complete.
 */

export const MAX_FILES_PER_DRAFT = 10;
export const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
export const MAX_BYTES_PER_DRAFT = 50 * 1024 * 1024;

/**
 * What may be attached, by magic number.
 *
 * An allow-list of formats that are inert when opened — no SVG and no HTML,
 * both of which carry script and are exactly what somebody would send if they
 * wanted our staff screen to run their code.
 */
const SIGNATURES: readonly { mime: string; extension: string; matches: (bytes: Uint8Array) => boolean }[] = [
  {
    mime: "image/png",
    extension: "png",
    matches: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/jpeg",
    extension: "jpg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    // "RIFF" .... "WEBP" — the size sits between the two markers.
    mime: "image/webp",
    extension: "webp",
    matches: (b) =>
      b.length > 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    mime: "application/pdf",
    extension: "pdf",
    matches: (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  },
];

export interface SniffedType {
  mime: string;
  extension: string;
}

/** The real type of these bytes, or null if it is not one we accept. */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  const found = SIGNATURES.find((signature) => signature.matches(bytes));
  return found ? { mime: found.mime, extension: found.extension } : null;
}

/**
 * The name shown back to the customer. Never a path, never a header value.
 *
 * Separators and traversal are stripped, and the length is capped. The stored
 * file gets a generated name entirely — this is a label and nothing else.
 */
export function displayName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const clean = base.replaceAll("..", "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return clean.length > 0 ? clean.slice(0, 200) : "attachment";
}

export type AssetRefusal =
  | { ok: false; reason: string };

export type AssetAccepted = {
  ok: true;
  /** Where the bytes should be written, relative to the storage root. */
  storageKey: string;
  type: SniffedType;
  checksum: string;
};

/**
 * Decides whether a file may be stored, before a byte is written to disk.
 *
 * Every limit is checked here rather than at the edges, so the reasons come
 * back in words a customer can act on — "that is bigger than 10MB" tells them
 * what to do, "upload failed" does not.
 */
export async function checkAsset(
  db: Db,
  organisationId: string,
  sessionId: string,
  file: { name: string; bytes: Uint8Array },
): Promise<AssetAccepted | AssetRefusal> {
  if (file.bytes.length === 0) return { ok: false, reason: "That file is empty." };
  if (file.bytes.length > MAX_BYTES_PER_FILE) {
    return { ok: false, reason: `That file is larger than ${MAX_BYTES_PER_FILE / 1024 / 1024}MB.` };
  }

  const type = sniffType(file.bytes);
  if (!type) {
    // Deliberately says what is allowed rather than what was detected: naming
    // the sniffed type would help somebody work out how to get past the check.
    return { ok: false, reason: "That has to be a PNG, JPEG, WebP or PDF." };
  }

  const existing = await db
    .select({ bytes: schema.briefAssets.bytes })
    .from(schema.briefAssets)
    .where(
      and(
        eq(schema.briefAssets.organisationId, organisationId),
        eq(schema.briefAssets.sessionId, sessionId),
        ne(schema.briefAssets.status, "deleted"),
      ),
    );

  if (existing.length >= MAX_FILES_PER_DRAFT) {
    return { ok: false, reason: `That is more than ${MAX_FILES_PER_DRAFT} files. Remove one first.` };
  }
  const used = existing.reduce((total, row) => total + row.bytes, 0);
  if (used + file.bytes.length > MAX_BYTES_PER_DRAFT) {
    return { ok: false, reason: `That would take this brief over ${MAX_BYTES_PER_DRAFT / 1024 / 1024}MB in total.` };
  }

  return {
    ok: true,
    // Generated entirely. The customer's name survives only as a label, so
    // nothing they chose can influence where the file lands.
    storageKey: `brief/${sessionId}/${randomUUID()}.${type.extension}`,
    type,
    checksum: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

export type BriefAssetRow = typeof schema.briefAssets.$inferSelect;

/** Records a file whose bytes are already safely written. */
export async function recordAsset(
  db: Db,
  organisationId: string,
  sessionId: string,
  input: { storageKey: string; originalName: string; mime: string; bytes: number; checksum: string },
): Promise<BriefAssetRow> {
  const [row] = await db
    .insert(schema.briefAssets)
    .values({
      organisationId,
      sessionId,
      storageKey: input.storageKey,
      originalName: displayName(input.originalName),
      detectedMime: input.mime,
      bytes: input.bytes,
      checksum: input.checksum,
      status: "ready",
    })
    .returning();
  return row!;
}

/** What a draft has attached, for the form and for the brief. */
export async function assetsForSession(
  db: Db,
  organisationId: string,
  sessionId: string,
): Promise<BriefAssetRow[]> {
  return db
    .select()
    .from(schema.briefAssets)
    .where(
      and(
        eq(schema.briefAssets.organisationId, organisationId),
        eq(schema.briefAssets.sessionId, sessionId),
        eq(schema.briefAssets.status, "ready"),
      ),
    )
    .orderBy(schema.briefAssets.createdAt);
}

/**
 * Removes a file from a draft.
 *
 * Marked `deleted` rather than dropped: the row is what says a storage key was
 * ever used, and a key reused after a hard delete would serve one customer the
 * previous one's file. Returns the key so the caller can unlink the bytes.
 */
export async function deleteAsset(
  db: Db,
  organisationId: string,
  sessionId: string,
  assetId: string,
): Promise<{ storageKey: string } | null> {
  const [row] = await db
    .update(schema.briefAssets)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(
      and(
        eq(schema.briefAssets.id, assetId),
        eq(schema.briefAssets.organisationId, organisationId),
        // Scoped to the session as well as the organisation: the cookie proves
        // which draft you are, and it must not reach another one's files.
        eq(schema.briefAssets.sessionId, sessionId),
      ),
    )
    .returning({ storageKey: schema.briefAssets.storageKey });
  return row ?? null;
}
