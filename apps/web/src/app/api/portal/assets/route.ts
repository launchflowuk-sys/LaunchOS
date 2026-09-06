import { createContentAsset } from "@launchos/core";
import { NextResponse } from "next/server";
import { parseImageUpload, uploadFailure } from "@/lib/asset-upload";
import { getDb } from "@/lib/db";
import { getClientSession } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * "Add photos" on the portal's Content tab: a client uploading a photo of
 * their own work into their library. The client comes from the session,
 * never the form — a portal user can only ever add to their own client.
 * Recorded with source `client` so the writer and the staff library can tell
 * the client's photos from ours.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const parsed = await parseImageUpload(request);
  if (parsed instanceof Response) return parsed;
  const { file, alt } = parsed;

  try {
    const asset = await createContentAsset(getDb(), session.organisationId, {
      clientId: session.clientId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      originalName: file.name || "photo",
      ...(alt ? { alt } : {}),
      source: "client",
      actorKind: "user",
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, asset: { id: asset.id, originalName: asset.originalName, sizeBytes: asset.sizeBytes } });
  } catch (error) {
    return uploadFailure(error, { clientId: session.clientId });
  }
}
