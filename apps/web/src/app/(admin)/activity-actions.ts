"use server";

import { recordStaffActivity } from "@launchos/core";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { helpRouteFor } from "@/lib/help-routes";

/**
 * Records that this member looked at this screen.
 *
 * The route is normalised to a nav entry before it is stored — `/clients` for
 * every client, never `/clients/8f21…`. That is the difference between a
 * workload picture and a record of which client somebody opened at 3pm, and
 * only the first was asked for.
 *
 * Failures are swallowed. This is telemetry: a person navigating must never see
 * an error because a count could not be written, and a dead database has louder
 * symptoms than a missing tally.
 */
export async function recordScreenView(pathname: string): Promise<void> {
  try {
    const session = await getSession();
    if (!session) return;
    await recordStaffActivity(getDb(), session.organisationId, {
      userId: session.userId,
      route: helpRouteFor(pathname),
    });
  } catch {
    // Deliberately silent — see above.
  }
}
