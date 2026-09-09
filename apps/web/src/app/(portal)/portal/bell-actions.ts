"use server";

import { markPortalSeen } from "@launchos/core";
import { getDb } from "@/lib/db";
import { getClientSession } from "@/lib/portal-session";

/**
 * "The client has now looked at the bell."
 *
 * `getClientSession` rather than `requireClient`: this is fired from a toggle,
 * and a signed-out caller should be a quiet no-op rather than a redirect the
 * transition cannot follow. The user id comes from the session, never from an
 * argument — there is no parameter here for a reason.
 */
export async function markPortalSeenAction(): Promise<void> {
  const session = await getClientSession();
  if (!session) return;
  await markPortalSeen(getDb(), session.organisationId, session.userId);
}
