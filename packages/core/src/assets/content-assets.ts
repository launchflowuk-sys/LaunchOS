import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { storageRoot } from "@launchos/channels";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { appUrl } from "../config.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";

export type ContentAssetRow = typeof schema.contentAssets.$inferSelect;

/** The image types Meta and WordPress both accept. */
export const CONTENT_ASSET_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ContentAssetMime = (typeof CONTENT_ASSET_MIMES)[number];
const EXTENSION: Readonly<Record<ContentAssetMime, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** 8 MB — Meta's limit for a photo post; well above what a web image needs. */
export const MAX_CONTENT_ASSET_BYTES = 8 * 1024 * 1024;

/** The public route the web app serves assets from; the id is the only key. */
export const ASSET_ROUTE_PATH = "/api/assets";

/**
 * The URL a post carries as `image_url`. Fetchable by Meta and WordPress
 * without cookies, so tenancy is the unguessable uuid alone — never enumerate
 * asset ids anywhere public.
 */
export function publicAssetUrl(assetId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${appUrl(env)}${ASSET_ROUTE_PATH}/${assetId}`;
}

/** Where the file lives on disk: `STORAGE_DIR/<path>`. */
export function contentAssetFilePath(asset: Pick<ContentAssetRow, "path">, env: NodeJS.ProcessEnv = process.env): string {
  return join(storageRoot(env), asset.path);
}

export class ContentAssetRefused extends Error {
  constructor(readonly reason: "unsupported_type" | "too_large" | "empty", message: string) {
    super(message);
    this.name = "ContentAssetRefused";
  }
}

export const CreateContentAssetInput = z.object({
  clientId: z.string().uuid(),
  /** The file bytes, already read from the upload. */
  bytes: z.instanceof(Uint8Array),
  mime: z.string().min(1).max(100),
  /** The uploaded file's name — kept as a label only. */
  originalName: z.string().max(200).optional(),
  alt: z.string().trim().max(500).optional(),
  source: z.enum(["client", "staff", "generated"]).default("staff"),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type CreateContentAssetInput = z.input<typeof CreateContentAssetInput>;

/**
 * Stores an image for a client's posts under
 * `STORAGE_DIR/content/<org>/<uuid>.<ext>` and records it. JPEG, PNG and WebP
 * only, at most 8 MB; anything else is a `ContentAssetRefused` with a sentence
 * the upload form can show. The file is written before the row so a crash
 * between the two leaves an orphan file, never a row pointing at nothing.
 */
export async function createContentAsset(
  db: Db,
  organisationId: string,
  input: CreateContentAssetInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContentAssetRow> {
  const v = CreateContentAssetInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);
  const mime = v.mime.toLowerCase().split(";")[0]!.trim();
  if (!(CONTENT_ASSET_MIMES as readonly string[]).includes(mime)) {
    throw new ContentAssetRefused("unsupported_type", "Please upload a JPEG, PNG or WebP image.");
  }
  if (v.bytes.byteLength === 0) throw new ContentAssetRefused("empty", "That file is empty.");
  if (v.bytes.byteLength > MAX_CONTENT_ASSET_BYTES) {
    throw new ContentAssetRefused("too_large", `Images must be ${MAX_CONTENT_ASSET_BYTES / 1024 / 1024} MB or smaller.`);
  }

  const id = randomUUID();
  const relative = join("content", organisationId, `${id}.${EXTENSION[mime as ContentAssetMime]}`).replaceAll("\\", "/");
  const dir = join(storageRoot(env), "content", organisationId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(storageRoot(env), relative), v.bytes);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.contentAssets).values({
      id,
      organisationId,
      clientId: v.clientId,
      path: relative,
      mime,
      sizeBytes: v.bytes.byteLength,
      originalName: v.originalName?.slice(0, 200) ?? null,
      alt: v.alt ?? null,
      source: v.source,
      uploadedByUserId: v.actorKind === "user" || v.actorKind === "client" ? (v.actorId ?? null) : null,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_asset.created",
      targetType: "content_asset", targetId: row!.id, after: row,
    });
    return row!;
  });
}

export const ListContentAssetsInput = z.object({
  clientId: z.string().uuid(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ListContentAssetsInput = z.input<typeof ListContentAssetsInput>;

/** A client's images, newest first, with the public URL each one would carry on a post. */
export async function listContentAssets(db: Db, organisationId: string, input: ListContentAssetsInput, env: NodeJS.ProcessEnv = process.env) {
  const v = ListContentAssetsInput.parse(input);
  const rows = await db.select().from(schema.contentAssets)
    .where(and(
      eq(schema.contentAssets.organisationId, organisationId),
      eq(schema.contentAssets.clientId, v.clientId),
      isNull(schema.contentAssets.deletedAt),
    ))
    .orderBy(desc(schema.contentAssets.createdAt), desc(schema.contentAssets.id))
    .limit(v.limit);
  return rows.map((row) => ({ ...row, url: publicAssetUrl(row.id, env) }));
}

export const GetContentAssetInput = z.object({ assetId: z.string().uuid() });
export type GetContentAssetInput = z.input<typeof GetContentAssetInput>;

export async function getContentAsset(db: Db, organisationId: string, input: GetContentAssetInput): Promise<ContentAssetRow | null> {
  const v = GetContentAssetInput.parse(input);
  const [row] = await db.select().from(schema.contentAssets)
    .where(and(eq(schema.contentAssets.id, v.assetId), eq(schema.contentAssets.organisationId, organisationId), isNull(schema.contentAssets.deletedAt)));
  return row ?? null;
}

export const DeleteContentAssetInput = z.object({
  assetId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type DeleteContentAssetInput = z.input<typeof DeleteContentAssetInput>;

/**
 * Removes the row and the file. A post still pointing at the URL will 404 at
 * publish time and be failed by the publish job with a clear message, so the
 * library UI should warn before deleting an image a scheduled post uses.
 */
export async function deleteContentAsset(
  db: Db,
  organisationId: string,
  input: DeleteContentAssetInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContentAssetRow | null> {
  const v = DeleteContentAssetInput.parse(input);
  const removed = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.delete(schema.contentAssets)
      .where(and(eq(schema.contentAssets.id, v.assetId), eq(schema.contentAssets.organisationId, organisationId)))
      .returning();
    if (!row) return null;
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_asset.deleted",
      targetType: "content_asset", targetId: row.id, before: row,
    });
    return row;
  });
  if (removed) await rm(contentAssetFilePath(removed, env), { force: true });
  return removed;
}

/**
 * The file for the public route — **by id only, no organisation**, because
 * Meta and WordPress fetch the URL with no session. The uuid is the secret.
 * Null when there is no such asset or its file is gone.
 */
export async function readContentAsset(
  db: Db,
  assetId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ asset: ContentAssetRow; bytes: Buffer } | null> {
  if (!z.string().uuid().safeParse(assetId).success) return null;
  const [asset] = await db.select().from(schema.contentAssets)
    .where(and(eq(schema.contentAssets.id, assetId), isNull(schema.contentAssets.deletedAt)));
  if (!asset) return null;
  try {
    return { asset, bytes: await readFile(contentAssetFilePath(asset, env)) };
  } catch {
    return null;
  }
}
