import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

/**
 * Which agents this organisation has switched on.
 *
 * Returned as a map rather than a list of enabled keys, because the caller is
 * merging it against the registry and needs to tell three states apart: on, off,
 * and never configured. A `Set` of enabled keys collapses the last two, and they
 * are not the same thing — "you turned this off" and "this arrived after you
 * last looked" want different words on screen.
 *
 * A key present here that is not in the registry is an agent that was retired
 * with its row left behind. The caller decides what to do with that; this
 * function reports what is stored and does not editorialise.
 */
export async function listAgentEnablement(db: Db, organisationId: string): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ agentKey: schema.agentEnablement.agentKey, enabled: schema.agentEnablement.enabled })
    .from(schema.agentEnablement)
    .where(eq(schema.agentEnablement.organisationId, organisationId));

  return Object.fromEntries(rows.map((row) => [row.agentKey, row.enabled]));
}
