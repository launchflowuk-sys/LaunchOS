import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { attachmentContentDisposition, storageRoot } from "@launchos/channels";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteContext<"/api/attachments/[org]/[file]">) {
  const session = await requireAdmin();
  const { org, file } = await params;
  // Two guards: the caller's own organisation must own the directory, and the
  // file segment is reduced to a basename so no traversal survives.
  if (org !== session.organisationId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const safe = basename(file);
  try {
    const bytes = await readFile(join(storageRoot(), "attachments", org, safe));
    return new NextResponse(bytes, {
      // Never interpolate the name raw: it descends from an attacker-supplied
      // attachment name, and a quote in it forges a second `filename*`
      // parameter that RFC 6266 prefers over the real one.
      headers: { "content-type": "application/octet-stream", "content-disposition": attachmentContentDisposition(safe) },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
