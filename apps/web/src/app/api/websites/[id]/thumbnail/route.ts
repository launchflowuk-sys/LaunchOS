import { readSiteThumbnail } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A site's thumbnail, for the websites list.
 *
 * Session-guarded and organisation-scoped, unlike `/api/assets/[id]` next door.
 * That one is deliberately public because Facebook and WordPress fetch a post's
 * image with no cookie; nothing outside this admin app ever asks for a
 * thumbnail, so it gets the ordinary rule instead — and `readSiteThumbnail`
 * filters on the session's organisation, so a valid session for one tenant
 * cannot read another tenant's picture by guessing a site id.
 *
 * `no-store` rather than a long immutable cache, again unlike assets: an asset
 * is immutable because replacing it mints a new id, whereas this URL is stable
 * and its bytes change every time the refresh job runs. A cached thumbnail
 * would show yesterday's homepage after a redesign went live, which is the one
 * thing the picture exists to reveal.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/websites/[id]/thumbnail">) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const { id } = await params;
  const found = await readSiteThumbnail(getDb(), session.organisationId, id);
  // No picture yet is a 404, and the list renders its own placeholder for that
  // rather than a broken image.
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(found.bytes), {
    headers: {
      "content-type": found.mime,
      "content-length": String(found.bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Useful when someone asks how old the picture is.
      "last-modified": found.capturedAt.toUTCString(),
    },
  });
}
