import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { storageRoot } from "@launchos/channels";
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
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${safe}"` },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
