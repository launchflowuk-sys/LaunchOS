import type { Db } from "@launchos/db";
import type { PaymentsAdapter } from "@launchos/integrations";
import { recordUsage } from "./usage.js";

/**
 * Stripe's cut, read off its own ledger.
 *
 * The one cost that cannot be metered when it happens. Stripe does not put its
 * fee on the invoice or the payment — it deducts it from the balance and
 * reports it as a separate balance transaction — so the only honest source is
 * asking afterwards. That is why `fee` exists as a usage product and
 * `processor_fee` as a source: it is a per-transaction variable cost like any
 * other, it just arrives late.
 *
 * Idempotent on Stripe's own transaction id, so running it twice in a day, or
 * re-running it over an overlapping window, records each fee exactly once.
 * That matters more here than anywhere else in the ledger: the window is a
 * lookback rather than a cursor, so overlap is the normal case rather than the
 * exception.
 *
 * A fee of zero is not recorded — a payout or an adjustment moves money without
 * costing anything, and a row of zeroes makes the ledger look busier than the
 * spend justifies.
 */

export interface StripeFeeSyncResult {
  /** Ledger lines Stripe reported in the window. */
  reported: number;
  /** Fees actually written. Lower than `reported` on a re-run, which is correct. */
  recorded: number;
  /** Total fee seen in the window, minor units, by currency. */
  feeByCurrency: Record<string, number>;
}

/** How far back to look. Wider than a day so a missed run heals itself. */
export const FEE_LOOKBACK_DAYS = 10;

export async function syncStripeFees(
  db: Db,
  organisationId: string,
  payments: PaymentsAdapter,
  now: Date = new Date(),
): Promise<StripeFeeSyncResult> {
  const since = new Date(now.getTime() - FEE_LOOKBACK_DAYS * 86_400_000);
  const rows = await payments.listBalanceTransactions(since);

  const feeByCurrency: Record<string, number> = {};
  let recorded = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.fee) || row.fee <= 0) continue;
    feeByCurrency[row.currency] = (feeByCurrency[row.currency] ?? 0) + row.fee;

    // Recorded in Stripe's own currency's minor units with the currency as the
    // variant, so a USD-settled account prices through the same FX rule as
    // everything else rather than being quietly treated as pence.
    const written = await recordUsage(db, organisationId, {
      supplier: "stripe",
      product: "fee",
      variant: row.currency,
      // The fee itself is the quantity, at one micro-penny per unit — the rate
      // card is not asked to invent a price for something the provider already
      // told us exactly.
      quantity: row.fee,
      unit: "minor",
      source: "processor_fee",
      occurredAt: row.createdAt,
      idempotencyKey: `stripe_fee:${row.id}`,
    }).catch(() => null);
    if (written) recorded += 1;
  }

  return { reported: rows.length, recorded, feeByCurrency };
}
