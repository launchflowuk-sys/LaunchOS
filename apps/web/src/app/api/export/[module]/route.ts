import { EXPORTABLE, exportModule, type Exportable } from "@launchos/core";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

/**
 * A CSV download, one module at a time.
 *
 * A route handler rather than a server action: a browser downloads a file
 * because a response says so, and a server action returns a value to
 * JavaScript. The `Content-Disposition` header is the whole reason this is a
 * route.
 *
 * Gated on `settings` — an export is every row in a module in one file, which
 * is a wider read than any screen offers.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ module: string }> },
): Promise<Response> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return new Response(gate.message, { status: 403 });

  const { module } = await params;
  if (!(EXPORTABLE as readonly string[]).includes(module)) {
    return new Response(`Unknown module. Try one of: ${EXPORTABLE.join(", ")}`, { status: 404 });
  }

  const result = await exportModule(getDb(), gate.session.organisationId, { module: module as Exportable });

  // The byte-order mark is what makes Excel on Windows read this as UTF-8
  // rather than guess Latin-1 and turn every £ into Â£. Sheets ignores it.
  const body = `﻿${result.csv}`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      // An export is a point-in-time snapshot; a cached one is a wrong one.
      "Cache-Control": "no-store",
    },
  });
}
