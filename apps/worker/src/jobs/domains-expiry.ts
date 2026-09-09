import { sweepDomainExpiry, syncDomainExpiry } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import type { RegistrarAdapter } from "@launchos/integrations";

/**
 * Walks every domain toward its renewal date. Runs at 07:15, before the
 * invoice sweep, so a morning's notifications arrive in the order somebody
 * would want to read them: what is about to break, then what is owed.
 *
 * Idempotent by threshold and by expiry date — see `sweepDomainExpiry`. A
 * domain warned at thirty days is silent again until it reaches fourteen, and
 * every threshold comes back to life once the registrar rolls the date on.
 */
export async function runDomainExpirySweep(
  db: Db,
  organisationId: string,
  options: { now: Date; registrar?: RegistrarAdapter | null; email?: EmailAdapter | undefined },
) {
  // Ask the registrar first, then warn on what it told us. The other order
  // would spend a whole day warning on yesterday's dates — and on the day a
  // domain is renewed, would warn about one that is no longer expiring.
  let synced: { matched: number; updated: number; unknown: number } | null = null;
  if (options.registrar) {
    try {
      const result = await syncDomainExpiry(db, organisationId, options.registrar, options.now);
      synced = { matched: result.matched, updated: result.updated.length, unknown: result.unknown.length };
    } catch (error) {
      // The registrar being unreachable must not cost us the warnings: the
      // dates already on record are still worth sweeping, and a stale date is
      // far better than silence.
      console.error("domain expiry sync failed; sweeping on the dates already stored", error);
    }
  }

  const result = await sweepDomainExpiry(db, organisationId, options.now, { email: options.email });
  return {
    synced,
    checked: result.checked,
    warned: result.notified.length,
    statusChanged: result.statusChanged,
    clientsEmailed: result.clientsEmailed.length,
    domains: result.notified.map((n) => `${n.name}@${n.threshold}d`),
  };
}
