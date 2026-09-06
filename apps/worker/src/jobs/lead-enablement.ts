import { LEAD_QUALIFIER_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { EnablementLogger } from "./content-enablement.js";

/**
 * Switches the Lead Qualifier on, once, for every organisation that has never
 * decided about it — the same insert-only default the Content Writer and the
 * Ops Brief get at boot. A row that exists, on or off, is never touched:
 * Settings → Agents stays the authority. The qualifier only drafts; nothing
 * it writes reaches a lead without the owner approving the card, so "on
 * unless switched off" is the right default.
 */
export async function ensureLeadQualifierEnabled(db: Db, logger: EnablementLogger = console): Promise<{ enabled: number }> {
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(organisations.map((org) => ({ organisationId: org.id, agentKey: LEAD_QUALIFIER_KEY, enabled: true })))
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId });
  if (inserted.length > 0) {
    logger.info({ agent: LEAD_QUALIFIER_KEY, organisations: inserted.map((r) => r.organisationId) }, "lead qualifier enabled by default");
  }
  return { enabled: inserted.length };
}
