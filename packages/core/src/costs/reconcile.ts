import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { rateFor, REPORTING_CURRENCY } from "./fx.js";

/**
 * Comparing what we metered against what the provider actually billed.
 *
 * The ledger's figures are an estimate until the bill arrives. The rate card
 * carries list prices; real accounts have volume discounts, credits, price
 * changes mid-month and the occasional provider bug. Without this the ledger
 * drifts from reality quietly, and a margin nobody has checked is a margin
 * nobody should quote.
 *
 * **A missing credential reads as "not reconciled", never as a zero gap.**
 * That is the whole design rule here, and it is Shoji's: a provider we cannot
 * check must be visibly unchecked. Reporting a perfect match because we never
 * asked is the failure mode worth engineering against.
 */

export type ReconcileStatus =
  /** We have both figures and they agree within tolerance. */
  | "matched"
  /** We have both and they disagree by more than the tolerance. */
  | "gap"
  /** No credential, or the provider could not be reached. Not a zero gap. */
  | "not_reconciled";

/** Over this, a gap is worth a person looking. Shoji's number. */
export const GAP_TOLERANCE_PERCENT = 10;

export interface ReconcileResult {
  supplier: string;
  /** `2026-09`. */
  month: string;
  /** What the ledger says, GBP pence. */
  meteredPence: number;
  /** What the provider says, GBP pence. Null when we could not ask. */
  billedPence: number | null;
  /** billed − metered, GBP pence. Null when not reconciled. */
  gapPence: number | null;
  /** The gap as a percentage of the billed figure. Null when not reconciled. */
  gapPercent: number | null;
  status: ReconcileStatus;
  /** Why, in words, for the screen and the log. */
  note: string;
}

/** What the ledger metered for one supplier in a calendar month, GBP pence. */
export async function meteredForMonth(
  db: Db,
  organisationId: string,
  supplier: string,
  now: Date = new Date(),
): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await db
    .select({ pence: sql<string>`coalesce(sum(${schema.usageEvents.costPence}), 0)` })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organisationId, organisationId),
        eq(schema.usageEvents.supplier, supplier as never),
        gte(schema.usageEvents.occurredAt, from),
        lt(schema.usageEvents.occurredAt, to),
      ),
    );
  return Number(row?.pence ?? 0);
}

/**
 * Compares one supplier's month.
 *
 * `billedMinor` is in the provider's own currency — the providers bill in USD —
 * and is converted at the month's stored rate, the same rule the register
 * follows. `billedMinor: null` means we could not ask, and the result says
 * `not_reconciled` rather than pretending to a match.
 */
export async function reconcileSupplier(
  db: Db,
  organisationId: string,
  input: { supplier: string; billedMinor: number | null; billedCurrency?: string; note?: string },
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;
  const meteredPence = await meteredForMonth(db, organisationId, input.supplier, now);

  const base = { supplier: input.supplier, month, meteredPence };

  if (input.billedMinor === null || !Number.isFinite(input.billedMinor)) {
    return {
      ...base,
      billedPence: null,
      gapPence: null,
      gapPercent: null,
      status: "not_reconciled",
      note: input.note ?? "no usage credential for this provider, so nothing was compared",
    };
  }

  const currency = (input.billedCurrency ?? REPORTING_CURRENCY).toUpperCase();
  let billedPence = input.billedMinor;
  if (currency !== REPORTING_CURRENCY) {
    const micros = await rateFor(db, organisationId, currency, monthStart);
    if (micros === null) {
      return {
        ...base,
        billedPence: null,
        gapPence: null,
        gapPercent: null,
        status: "not_reconciled",
        // A rate we do not have is not a rate of 1.0, here as everywhere else.
        note: `the bill is in ${currency} and no exchange rate is stored for ${month}`,
      };
    }
    billedPence = Math.round((input.billedMinor * micros) / 1_000_000);
  }

  const gapPence = billedPence - meteredPence;
  const gapPercent = billedPence === 0 ? (meteredPence === 0 ? 0 : 100) : Math.abs(gapPence / billedPence) * 100;
  const matched = gapPercent <= GAP_TOLERANCE_PERCENT;

  return {
    ...base,
    billedPence,
    gapPence,
    gapPercent: Math.round(gapPercent * 10) / 10,
    status: matched ? "matched" : "gap",
    note: matched
      ? `within ${GAP_TOLERANCE_PERCENT}% of the bill`
      : `the bill is ${gapPence > 0 ? "higher" : "lower"} than metered by ${Math.round(gapPercent)}% — check the rate card`,
  };
}
