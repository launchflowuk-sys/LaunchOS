import { CONTENT_ASSET_MIMES, ContentAssetRefused, MAX_CONTENT_ASSET_BYTES } from "@launchos/core";
import { NextResponse } from "next/server";

/**
 * The multipart half of an image upload, shared by the staff route
 * (`/api/clients/[id]/assets`) and the portal one (`/api/portal/assets`).
 *
 * Route handlers rather than server actions for the same reason as task
 * screenshots: server actions cap their body at 1 MB by default and a phone
 * photo is more. The cap here is core's `MAX_CONTENT_ASSET_BYTES` (8 MB),
 * checked on the declared length before the body is read and on the file
 * after; the MIME check mirrors `createContentAsset` so the refusal reaches
 * the form as a sentence rather than a thrown `ContentAssetRefused`.
 */
export type ParsedImageUpload = { file: File; alt: string | undefined };

/** The multipart envelope adds a few hundred bytes to the file itself. */
const ENVELOPE_HEADROOM = 64 * 1024;

const MAX_MB = Math.round(MAX_CONTENT_ASSET_BYTES / (1024 * 1024));

export function imageTooLarge(): string {
  return `that image is over ${MAX_MB} MB — export a smaller copy and try again`;
}

/** Either the file and its alt text, or the response to send instead. */
export async function parseImageUpload(request: Request): Promise<ParsedImageUpload | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CONTENT_ASSET_BYTES + ENVELOPE_HEADROOM) {
    return NextResponse.json({ error: imageTooLarge() }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected a multipart form with a file" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "choose a photo first" }, { status: 400 });
  }
  if (file.size > MAX_CONTENT_ASSET_BYTES) return NextResponse.json({ error: imageTooLarge() }, { status: 413 });
  const mime = file.type.toLowerCase().split(";")[0]!.trim();
  if (!(CONTENT_ASSET_MIMES as readonly string[]).includes(mime)) {
    return NextResponse.json({ error: "that file is not a JPEG, PNG or WebP image" }, { status: 415 });
  }
  const rawAlt = form.get("alt");
  const alt = typeof rawAlt === "string" && rawAlt.trim().length > 0 ? rawAlt.trim().slice(0, 500) : undefined;
  return { file, alt };
}

/** A core refusal becomes the sentence it carries; anything else is ours to log. */
export function uploadFailure(error: unknown, context: Record<string, unknown>): Response {
  if (error instanceof ContentAssetRefused) return NextResponse.json({ error: error.message }, { status: 422 });
  const message = error instanceof Error ? error.message : "upload failed";
  if (message.includes("not found") || message.includes("does not belong")) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  console.error("[assets] upload failed", { ...context, error });
  return NextResponse.json({ error: "that photo could not be stored" }, { status: 500 });
}
