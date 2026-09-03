import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";

/**
 * Ownership guards for ids that arrive from outside the trust boundary — an
 * agent's tool input, an API body, a form post. Every domain write that takes
 * a foreign key it did not itself look up asserts first, so a caller cannot
 * reach across organisations by guessing or replaying an id.
 */
export async function assertClientInOrganisation(db: Db, organisationId: string, clientId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  if (!row) throw new Error(`client ${clientId} not found in organisation`);
}

export async function assertSiteInOrganisation(db: Db, organisationId: string, siteId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
  if (!row) throw new Error(`site ${siteId} not found in organisation`);
}
