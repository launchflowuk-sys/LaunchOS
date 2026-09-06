import { assertPermission, createContentAsset, PermissionDenied } from "@launchos/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseImageUpload, uploadFailure } from "@/lib/asset-upload";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A staff upload into a client's image library: `multipart/form-data` with
 * `file` and an optional `alt`.
 *
 * `getSession` rather than `requireAdmin` because a `fetch` needs a 401, not
 * a redirect to the sign-in page; the `content` permission is asked for the
 * same way the Channels and Brief actions ask for it, but answered as a 403.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/clients/[id]/assets">): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (session.role !== "owner") {
    try {
      await assertPermission(getDb(), session.organisationId, session.userId, "content");
    } catch (error) {
      if (error instanceof PermissionDenied) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  }

  const { id: clientId } = await params;
  if (!z.string().uuid().safeParse(clientId).success) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = await parseImageUpload(request);
  if (parsed instanceof Response) return parsed;
  const { file, alt } = parsed;

  try {
    const asset = await createContentAsset(getDb(), session.organisationId, {
      clientId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      originalName: file.name || "photo",
      ...(alt ? { alt } : {}),
      source: "staff",
      actorKind: "user",
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, asset: { id: asset.id, originalName: asset.originalName, sizeBytes: asset.sizeBytes } });
  } catch (error) {
    // `createContentAsset` asserts the client belongs to this organisation —
    // another tenant's client id is a 404, not a hint that it exists.
    return uploadFailure(error, { clientId });
  }
}
