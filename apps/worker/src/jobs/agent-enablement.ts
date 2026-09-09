import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";

export interface EnablementLogger {
  info(...args: unknown[]): void;
}

/**
 * Every agent in the registry is switched on, once, for every organisation
 * that has never decided about it.
 *
 * This used to be five near-identical functions — one written by hand each
 * time an agent shipped — and the trap was the one nobody wrote. An agent with
 * no `agent_enablement` row is indistinguishable from an agent somebody turned
 * off, so it does nothing, for ever, and says nothing about it. The Brief
 * Writer lost an afternoon to exactly that. Walking the registry means a new
 * agent cannot arrive in that state: if it is in `agentRegistry`, it has a row.
 *
 * "On unless switched off" is the safe default here and not a shortcut, because
 * nothing an agent does reaches a client, a DNS record or a payment without an
 * approval card first — see rule 2. The worst an enabled-by-default agent can
 * do is queue a decision for a human.
 *
 * The insert does nothing on conflict, so a row that exists — enabled, or
 * disabled by a person in Settings → Agents — is never touched. Turning an
 * agent off keeps it off across every deploy and restart.
 */
export async function ensureAgentsEnabled(db: Db, agentKeys: readonly string[], logger: EnablementLogger = console): Promise<{ enabled: number }> {
  if (agentKeys.length === 0) return { enabled: 0 };
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };

  const rows = organisations.flatMap((org) => agentKeys.map((agentKey) => ({ organisationId: org.id, agentKey, enabled: true })));
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(rows)
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId, agentKey: schema.agentEnablement.agentKey });

  if (inserted.length > 0) {
    logger.info({ enabled: inserted.map((row) => `${row.agentKey}:${row.organisationId}`) }, "agents enabled by default");
  }
  return { enabled: inserted.length };
}
