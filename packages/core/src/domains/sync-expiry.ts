import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { RegistrarAdapter } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";

/**
 * Fills in renewal dates from the registrar, so nobody has to type them.
 *
 * `domains.expires_at` existed for months with nothing able to write to it, and
 * the form added on 9 Sep 2026 fixed that by hand — twelve domains, twelve
 * trips to a registrar's control panel, and a date that silently goes stale the
 * moment one renews. This is the other half: the registrar already knows, so
 * ask it.
 *
 * **Read-only.** Nothing here buys, transfers or renews anything. The worst
 * this can do is write a wrong date, which the next run corrects.
 */

export interface SyncDomainExpiryResult {
  /** Domains the registrar reported. */
  reported: number;
  /** Ours that matched one, by name. */
  matched: number;
  /** Ours whose date or auto-renew actually changed. */
  updated: { name: string; expiresAt: Date | null; autoRenew: boolean }[];
  /** Reported by the registrar and not on our books at all — worth knowing about. */
  unknown: string[];
}

/**
 * Matched on the domain name alone, which is the only thing both sides agree
 * on: we hold no registrar id, and a domain can move registrar without its
 * name changing. Names are compared lower-cased and de-dotted on both sides.
 */
export async function syncDomainExpiry(
  db: Db,
  organisationId: string,
  registrar: RegistrarAdapter,
  now: Date = new Date(),
): Promise<SyncDomainExpiryResult> {
  const reported = await registrar.listDomains();
  const byName = new Map(reported.map((entry) => [entry.name, entry]));

  const ours = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      expiresAt: schema.domains.expiresAt,
      registeredAt: schema.domains.registeredAt,
      autoRenew: schema.domains.autoRenew,
      registrar: schema.domains.registrar,
    })
    .from(schema.domains)
    .where(eq(schema.domains.organisationId, organisationId));

  const updated: SyncDomainExpiryResult["updated"] = [];
  const seen = new Set<string>();
  let matched = 0;

  for (const domain of ours) {
    const key = domain.name.trim().toLowerCase().replace(/\.$/, "");
    const entry = byName.get(key);
    if (!entry) continue;
    matched += 1;
    seen.add(key);

    // `autoRenew` stays as it is when the registrar does not report it: null
    // means "not stated", and overwriting a deliberate setting with a guess is
    // how a domain set to renew by hand quietly starts claiming it renews
    // itself.
    const nextAutoRenew = entry.autoRenew ?? domain.autoRenew;
    const dateChanged = entry.expiresAt !== null
      && domain.expiresAt?.getTime() !== entry.expiresAt.getTime();
    const renewChanged = nextAutoRenew !== domain.autoRenew;
    // Written once and then left alone. A registration date does not change,
    // and it is what lets an anonymous `.CO.UK Domain` line on the supplier's
    // bill find which of seven `.co.uk` domains it pays for.
    const registeredChanged = entry.registeredAt !== null && domain.registeredAt === null;
    // Only fills the registrar in; never overwrites a name somebody typed.
    const registrarName = domain.registrar ?? registrar.name;
    const registrarChanged = registrarName !== domain.registrar;

    if (!dateChanged && !renewChanged && !registrarChanged && !registeredChanged) continue;

    await db.update(schema.domains)
      .set({
        ...(dateChanged ? { expiresAt: entry.expiresAt } : {}),
        ...(registeredChanged ? { registeredAt: entry.registeredAt } : {}),
        ...(renewChanged ? { autoRenew: nextAutoRenew } : {}),
        ...(registrarChanged ? { registrar: registrarName } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.organisationId, organisationId)));

    await recordAudit(db, organisationId, {
      actorKind: "system", action: "domain.expiry_synced",
      targetType: "domain", targetId: domain.id,
      before: { expiresAt: domain.expiresAt, autoRenew: domain.autoRenew, registrar: domain.registrar },
      after: { expiresAt: entry.expiresAt ?? domain.expiresAt, autoRenew: nextAutoRenew, registrar: registrarName, status: entry.status },
    });

    updated.push({ name: domain.name, expiresAt: entry.expiresAt ?? domain.expiresAt, autoRenew: nextAutoRenew });
  }

  return {
    reported: reported.length,
    matched,
    updated,
    // Not an error and not written anywhere: a domain on the registrar account
    // that LaunchOS has never been told about is usually one nobody has added
    // yet, and the count is the nudge to go and add it.
    unknown: reported.map((entry) => entry.name).filter((name) => !seen.has(name)),
  };
}
