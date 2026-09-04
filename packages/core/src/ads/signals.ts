import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { assertOwned } from "../tenancy/assert-owned.js";

export const SIGNAL_WINDOW_DAYS = 7;
export const ROAS_DROP_THRESHOLD_PERCENT = 20;
export const CPC_RISE_THRESHOLD_PERCENT = 30;

export interface SignalWindow {
  from: string;
  to: string;
  days: number;
  spendPence: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  roas: number;
  cpcPence: number;
}

export interface AccountSignals {
  adAccountId: string;
  name: string;
  platform: "google" | "meta";
  currency: string;
  clientId: string;
  clientName: string;
  current: SignalWindow;
  previous: SignalWindow;
  roasDeltaPercent: number;
  cpcDeltaPercent: number;
  flagged: boolean;
  reasons: string[];
}

function isoDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function summarise(rows: (typeof schema.adMetricSnapshots.$inferSelect)[], from: string, to: string): SignalWindow {
  const spendPence = rows.reduce((s, r) => s + r.spendPence, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const conversionValuePence = rows.reduce((s, r) => s + r.conversionValuePence, 0);
  return {
    from, to, days: rows.length, spendPence, clicks, conversions, conversionValuePence,
    roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
    cpcPence: clicks === 0 ? 0 : spendPence / clicks,
  };
}

function deltaPercent(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Compares the last 7 days against the 7 before them. Returns the raw windows
 * as well as the verdict so the agent can quote real figures rather than
 * inventing them, and so the admin screen can show the same numbers.
 */
export async function computeAccountSignals(
  db: Db,
  organisationId: string,
  adAccountId: string,
  options: { now: Date },
): Promise<AccountSignals> {
  await assertOwned(db, organisationId, schema.adAccounts, adAccountId);
  const [account] = await db.select({
    id: schema.adAccounts.id,
    name: schema.adAccounts.name,
    platform: schema.adAccounts.platform,
    currency: schema.adAccounts.currency,
    clientId: schema.adAccounts.clientId,
    clientName: schema.clients.name,
  })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(eq(schema.adAccounts.id, adAccountId));

  const currentFrom = isoDay(options.now, SIGNAL_WINDOW_DAYS);
  const previousFrom = isoDay(options.now, SIGNAL_WINDOW_DAYS * 2);
  const today = isoDay(options.now, 0);

  const rows = await db.select().from(schema.adMetricSnapshots).where(and(
    eq(schema.adMetricSnapshots.organisationId, organisationId),
    eq(schema.adMetricSnapshots.adAccountId, adAccountId),
    gte(schema.adMetricSnapshots.date, previousFrom),
    lt(schema.adMetricSnapshots.date, today),
  ));

  const current = summarise(rows.filter((r) => r.date >= currentFrom), currentFrom, today);
  const previous = summarise(rows.filter((r) => r.date < currentFrom), previousFrom, currentFrom);

  const roasDeltaPercent = deltaPercent(current.roas, previous.roas);
  const cpcDeltaPercent = deltaPercent(current.cpcPence, previous.cpcPence);

  const reasons: string[] = [];
  // A missing prior window is not a signal — a new account would otherwise be
  // flagged on its first week.
  if (previous.days > 0) {
    if (roasDeltaPercent <= -ROAS_DROP_THRESHOLD_PERCENT) {
      reasons.push(`ROAS fell ${Math.abs(roasDeltaPercent).toFixed(1)}% (${previous.roas.toFixed(2)} → ${current.roas.toFixed(2)})`);
    }
    if (cpcDeltaPercent >= CPC_RISE_THRESHOLD_PERCENT) {
      reasons.push(`CPC rose ${cpcDeltaPercent.toFixed(1)}% (${(previous.cpcPence / 100).toFixed(2)} → ${(current.cpcPence / 100).toFixed(2)} per click)`);
    }
  }

  return {
    adAccountId,
    name: account!.name,
    platform: account!.platform,
    currency: account!.currency,
    clientId: account!.clientId,
    clientName: account!.clientName,
    current,
    previous,
    roasDeltaPercent,
    cpcDeltaPercent,
    flagged: reasons.length > 0,
    reasons,
  };
}
