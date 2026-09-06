import { readContentAsset } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * A client's image, served publicly by id.
 *
 * No session on purpose: Facebook, Instagram and WordPress fetch a post's
 * `image_url` themselves, with no cookie, so the unguessable uuid is the
 * whole of the access control (`readContentAsset` is by id only, and asset
 * ids are never listed anywhere public). A year of `immutable` cache is safe
 * because an asset's bytes never change — replacing an image is a new id.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/assets/[id]">): Promise<Response> {
  const { id } = await params;
  // A malformed id is a 404 before it reaches Postgres — `readContentAsset`
  // refuses a non-uuid itself, so no 22P02 can surface here.
  const found = await readContentAsset(getDb(), id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(found.bytes), {
    headers: {
      "content-type": found.asset.mime,
      "content-length": String(found.bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      // An image, never a page: a browser opening the URL directly must not
      // be talked into sniffing it as anything else.
      "x-content-type-options": "nosniff",
    },
  });
}
