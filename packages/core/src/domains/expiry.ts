import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";

/**
 * Watching domains toward their renewal date.
 *
 * A domain that lapses takes the client's website and their email with it, and
 * it is the one failure in this product nobody finds out about from a
 * monitor — the site is fine right up until the registrar pulls the record.
 * `domains.expires_at` has existed since the first migration and nothing ever
 * wrote to it or looked at it, so every domain read "Expires: —" and the whole
 * column was decoration.
 *
 * Notifying is therefore the point of this module, and notifying *once* is the
 * hard part: a daily sweep that re-sends at every run is one somebody mutes in
 * a fortnight, and a muted renewal warning is worse than none because it reads
 * as covered.
 */

/**
 * Days out from expiry at which we speak up. Descending, and deliberately
 * sparse near the end: sixty days is "put it on the list", seven is "do it
 * this week", one is "today or it goes".
 */
export const EXPIRY_THRESHOLD_DAYS = [60, 30, 14, 7, 1] as const;
export type ExpiryThreshold = (typeof EXPIRY_THRESHOLD_DAYS)[number];

/** `domains.metadata` — which warnings have already gone out, and for which date. */
export const EXPIRY_NOTIFIED_KEY = "expiryNotified";

const DAY_MS = 86_400_000;

/**
 * What has already been sent, keyed by the expiry date it was sent about.
 *
 * Keying by the date is what makes a renewal reset the warnings: once the
 * registrar rolls `expires_at` forward a year, the stored key no longer
 * matches and every threshold is live again. A plain list of thresholds would
 * have gone quiet for ever after the first cycle.
 */
const NotifiedState = z.object({
  at: z.string(),
  thresholds: z.array(z.number().int()),
});

export function alreadyNotified(metadata: Record<string, unknown>, expiresAt: Date): number[] {
  const parsed = NotifiedState.safeParse(metadata[EXPIRY_NOTIFIED_KEY]);
  if (!parsed.success) return [];
  return parsed.data.at === expiresAt.toISOString() ? parsed.data.thresholds : [];
}

/** Whole days from `now` until `expiresAt`; negative once it has gone. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

/**
 * The tightest threshold this domain has crossed and not yet been warned
 * about, or null. Tightest rather than every crossed one, because a domain
 * first seen nine days out should produce "7 days", not four notifications in
 * a row.
 */
export function dueThreshold(days: number, notified: readonly number[]): ExpiryThreshold | null {
  for (const threshold of [...EXPIRY_THRESHOLD_DAYS].sort((a, b) => a - b)) {
    if (days <= threshold && !notified.includes(threshold)) return threshold;
  }
  return null;
}

/** What the domain's own `status` column should say, given how close it is. */
export function statusFor(days: number): "active" | "expiring" | "expired" {
  if (days < 0) return "expired";
  return days <= EXPIRY_THRESHOLD_DAYS[0] ? "expiring" : "active";
}

export interface ExpiringDomain {
  id: string;
  name: string;
  clientId: string;
  clientName: string | null;
  expiresAt: Date;
  autoRenew: boolean;
  registrar: string | null;
  days: number;
}

/** Every domain with a date on it, soonest first. The caller decides what is urgent. */
export async function listDomainsByExpiry(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<ExpiringDomain[]> {
  const rows = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      clientId: schema.domains.clientId,
      clientName: schema.clients.name,
      expiresAt: schema.domains.expiresAt,
      autoRenew: schema.domains.autoRenew,
      registrar: schema.domains.registrar,
    })
    .from(schema.domains)
    .leftJoin(schema.clients, eq(schema.domains.clientId, schema.clients.id))
    .where(and(eq(schema.domains.organisationId, organisationId), isNotNull(schema.domains.expiresAt)))
    .orderBy(asc(schema.domains.expiresAt));

  return rows
    .filter((row): row is typeof row & { expiresAt: Date } => row.expiresAt !== null)
    .map((row) => ({ ...row, days: daysUntil(row.expiresAt, now) }));
}

export interface ExpirySweepResult {
  checked: number;
  notified: { domainId: string; name: string; threshold: number }[];
  statusChanged: number;
}

/**
 * The daily pass.
 *
 * Two jobs that are deliberately separate: keeping `status` honest, which
 * happens on every run, and speaking up, which happens once per threshold.
 * A domain on auto-renew still gets the warning — auto-renew fails on an
 * expired card, and "it was set to renew" is exactly what people say after a
 * domain lapses.
 */
export async function sweepDomainExpiry(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<ExpirySweepResult> {
  const domains = await listDomainsByExpiry(db, organisationId, now);
  const notified: ExpirySweepResult["notified"] = [];
  let statusChanged = 0;

  for (const domain of domains) {
    const [row] = await db
      .select({ metadata: schema.domains.metadata, status: schema.domains.status })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.organisationId, organisationId)));
    if (!row) continue;

    // `transferring` is somebody mid-move and not ours to overwrite.
    const wanted = statusFor(domain.days);
    if (row.status !== "transferring" && row.status !== wanted) {
      await db.update(schema.domains)
        .set({ status: wanted, updatedAt: now })
        .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.organisationId, organisationId)));
      statusChanged += 1;
    }

    const already = alreadyNotified(row.metadata, domain.expiresAt);
    const threshold = dueThreshold(domain.days, already);
    if (threshold === null) continue;

    const who = domain.clientName ? ` (${domain.clientName})` : "";
    const when = domain.days < 0
      ? `expired ${Math.abs(domain.days)} day${Math.abs(domain.days) === 1 ? "" : "s"} ago`
      : domain.days === 0
        ? "expires today"
        : `expires in ${domain.days} day${domain.days === 1 ? "" : "s"}`;

    await notifyOwner(db, organisationId, {
      kind: domain.days < 0 ? "domain.expired" : "domain.expiring",
      title: `${domain.name} ${when}`,
      body: domain.autoRenew
        ? `Set to auto-renew at ${domain.registrar ?? "the registrar"} — worth checking the card on file.`
        : `Auto-renew is off${domain.registrar ? ` at ${domain.registrar}` : ""}. This one needs renewing by hand.`,
      link: `/domains/${domain.id}`,
    });

    // Recorded against the client as well, so it reaches their portal rather
    // than living only in Shoji's bell.
    await recordActivity(db, organisationId, {
      clientId: domain.clientId,
      actorKind: "system",
      kind: domain.days < 0 ? "domain.expired" : "domain.expiring",
      title: `${domain.name}${who} ${when}`,
      link: `/domains/${domain.id}`,
    });

    await db.update(schema.domains)
      .set({
        metadata: sql`coalesce(${schema.domains.metadata}, '{}'::jsonb) || ${JSON.stringify({
          [EXPIRY_NOTIFIED_KEY]: { at: domain.expiresAt.toISOString(), thresholds: [...already, threshold] },
        })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.organisationId, organisationId)));

    await recordAudit(db, organisationId, {
      actorKind: "system", action: "domain.expiry_warned",
      targetType: "domain", targetId: domain.id,
      after: { threshold, days: domain.days, expiresAt: domain.expiresAt.toISOString() },
    });

    notified.push({ domainId: domain.id, name: domain.name, threshold });
  }

  return { checked: domains.length, notified, statusChanged };
}
