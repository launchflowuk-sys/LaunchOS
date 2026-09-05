import { CONTENT_WRITER_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";

export interface EnablementLogger {
  info(...args: unknown[]): void;
}

/**
 * Switches the Content Writer on, once, for every organisation that has never
 * decided about it.
 *
 * The other agents are enabled by the seed and by Settings → Agents. The
 * seed is `packages/db`'s, which this phase does not own, so the writer's
 * default lands here instead, at worker boot: an INSERT that does nothing on
 * conflict, so a row that exists — enabled or disabled by a person — is never
 * touched. An organisation that turns the writer off stays off. The writer
 * only ever runs when `content.plan-month` finds a live subscription with a
 * content quota, and nothing it writes leaves without an approval, so "on
 * unless switched off" is the right default for a package the client is
 * paying for.
 */
export async function ensureContentWriterEnabled(db: Db, logger: EnablementLogger = console): Promise<{ enabled: number }> {
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(organisations.map((org) => ({ organisationId: org.id, agentKey: CONTENT_WRITER_KEY, enabled: true })))
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId });
  if (inserted.length > 0) {
    logger.info({ agent: CONTENT_WRITER_KEY, organisations: inserted.map((r) => r.organisationId) }, "content writer enabled by default");
  }
  return { enabled: inserted.length };
}
