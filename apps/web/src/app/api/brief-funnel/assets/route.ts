import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assetsForSession, checkAsset, deleteAsset, MAX_BYTES_PER_FILE, recordAsset } from "@launchos/core";
import { storageRoot } from "@launchos/channels";
import { getDb } from "@/lib/db";
import { clientAddress } from "@/lib/rate-limit";
import { funnelLimiter, jsonError, jsonOk, sameOrigin, sessionFromRequest } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Files attached to a brief.
 *
 * Authorised by the draft's cookie like the rest of the funnel, so a customer
 * reaches their own files and nothing else. The bytes never leave the server:
 * these are somebody's logo and their old brochure, and there is no public URL
 * for any of it.
 *
 * The whole file is read into memory before anything is written, because the
 * type check needs the first bytes and the size check needs all of them, and
 * streaming to disk first would mean deciding whether to keep a file that is
 * already on the disk. Ten megabytes is small enough that this is the simpler
 * and safer order.
 */

/** GET — what this draft has attached. */
export async function GET(): Promise<Response> {
  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");

  const assets = await assetsForSession(getDb(), resolved.organisationId, resolved.session.id);
  return jsonOk({
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.originalName,
      bytes: asset.bytes,
      mime: asset.detectedMime,
    })),
  });
}

/** POST — one file, checked before a byte reaches the disk. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!funnelLimiter.allow(clientAddress(request))) return jsonError(429, "rate_limited", "Slow down a moment.");

  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");
  if (resolved.session.status !== "draft") return jsonError(409, "sent", "That brief has already been sent.");

  // Declared length first, so an oversized body is refused before it is read.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES_PER_FILE + 64 * 1024) {
    return jsonError(413, "too_large", "That file is larger than 10MB.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "bad_body", "That upload could not be read.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "no_file", "No file was sent.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = await checkAsset(getDb(), resolved.organisationId, resolved.session.id, {
    name: file.name,
    bytes,
  });
  if (!check.ok) return jsonError(422, "rejected", check.reason);

  const target = join(storageRoot(), check.storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);

  // The row is written after the bytes, so a row never promises a file that is
  // not there. The other order leaves a "ready" asset pointing at nothing.
  const asset = await recordAsset(getDb(), resolved.organisationId, resolved.session.id, {
    storageKey: check.storageKey,
    originalName: file.name,
    mime: check.type.mime,
    bytes: bytes.length,
    checksum: check.checksum,
  });

  return jsonOk({ asset: { id: asset.id, name: asset.originalName, bytes: asset.bytes, mime: asset.detectedMime } });
}

/** DELETE — removes one of this draft's own files. */
export async function DELETE(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");

  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");

  const id = new URL(request.url).searchParams.get("id") ?? "";
  const removed = await deleteAsset(getDb(), resolved.organisationId, resolved.session.id, id);
  if (!removed) return jsonError(404, "not_found", "That file is not on this brief.");

  // Best effort. The row already says deleted, and a file left behind is a
  // tidying job — reporting failure here would tell the customer their file is
  // still attached when as far as everything else is concerned it is gone.
  await unlink(join(storageRoot(), removed.storageKey)).catch(() => undefined);

  return jsonOk({ removed: id });
}
