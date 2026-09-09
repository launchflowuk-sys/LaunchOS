import { sweepDomainExpiry } from "@launchos/core";
import type { Db } from "@launchos/db";

/**
 * Walks every domain toward its renewal date. Runs at 07:15, before the
 * invoice sweep, so a morning's notifications arrive in the order somebody
 * would want to read them: what is about to break, then what is owed.
 *
 * Idempotent by threshold and by expiry date — see `sweepDomainExpiry`. A
 * domain warned at thirty days is silent again until it reaches fourteen, and
 * every threshold comes back to life once the registrar rolls the date on.
 */
export async function runDomainExpirySweep(db: Db, organisationId: string, options: { now: Date }) {
  const result = await sweepDomainExpiry(db, organisationId, options.now);
  return {
    checked: result.checked,
    warned: result.notified.length,
    statusChanged: result.statusChanged,
    domains: result.notified.map((n) => `${n.name}@${n.threshold}d`),
  };
}
