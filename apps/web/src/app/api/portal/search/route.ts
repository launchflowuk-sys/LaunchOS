import { PORTAL_SEARCH_EMPTY, searchPortal } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getClientSession } from "@/lib/portal-session";

/**
 * The portal's search box, server side.
 *
 * A route handler rather than a server action because this runs on every
 * keystroke: an action would be a POST that revalidates the router cache each
 * time, which is a page re-render for a dropdown.
 *
 * `getClientSession` rather than `requireClient` on purpose — `requireClient`
 * redirects, and a redirect is not an answer a `fetch` can do anything with.
 * A signed-out caller gets the empty shape and a 401, so the client component
 * has one thing to render either way.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getClientSession();
  if (!session) return NextResponse.json(PORTAL_SEARCH_EMPTY, { status: 401 });

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Two characters match half the account and are never what anyone meant.
  if (q.length < 2) return NextResponse.json(PORTAL_SEARCH_EMPTY);

  // The client id comes from the session, never from the request: a query
  // parameter here would be the whole tenancy boundary, typed by the caller.
  const results = await searchPortal(getDb(), session.organisationId, session.clientId, { q, limit: 4 });
  return NextResponse.json(results);
}
