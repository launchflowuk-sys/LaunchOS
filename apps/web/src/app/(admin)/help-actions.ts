"use server";

import { helpForRoute, type HelpArticle } from "@launchos/core";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { helpRouteFor } from "@/lib/help-routes";

/**
 * The guides for the screen the caller is looking at.
 *
 * A server action rather than a fetch in the layout, because a layout in the
 * App Router does not know the pathname on the server — and the help has to
 * follow the person around the app, not be decided once when the shell renders.
 *
 * The route is normalised here rather than trusted: `/clients/abc-123/payments`
 * is the Clients screen as far as help is concerned, and an article should not
 * have to be pinned to every client id in the database.
 */
export async function helpForCurrentRoute(
  pathname: string,
): Promise<{ route: string; articles: HelpArticle[] }> {
  const session = await requireAdmin();
  const route = helpRouteFor(pathname);
  // An owner sees everything written for the business; a staff member sees what
  // was written for them. Client-only articles never appear in the admin.
  const audience = session.role === "owner" ? "admin" : "staff";
  return { route, articles: await helpForRoute(getDb(), session.organisationId, route, audience) };
}
