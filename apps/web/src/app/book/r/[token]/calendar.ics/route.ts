import { meetingIcsByToken } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The meeting as a calendar file, by the guest's token.
 *
 * Linked from the confirmation email ("Add it to your calendar") and the
 * done page rather than attached: `messages` carry no attachments, and a
 * link stays correct after a reschedule because the file is generated on
 * request with the current `SEQUENCE`. `METHOD` follows the meeting — a
 * cancelled one answers `CANCEL` so a calendar removes the event rather than
 * keeping a ghost. The token is the whole access control, as on `/book/r`.
 */
export async function GET(_request: Request, { params }: RouteContext<"/book/r/[token]/calendar.ics">): Promise<Response> {
  const { token } = await params;
  const found = await meetingIcsByToken(getDb(), token);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  const method = found.ics.includes("METHOD:CANCEL") ? "CANCEL" : "REQUEST";
  return new NextResponse(found.ics, {
    headers: {
      "content-type": `text/calendar; charset=utf-8; method=${method}`,
      "content-disposition": `attachment; filename="${found.filename.replaceAll('"', "")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
