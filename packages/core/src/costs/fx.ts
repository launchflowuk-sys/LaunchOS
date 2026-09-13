import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

/**
 * Exchange rates, stored per day so a past month always reads the same.
 *
 * Reporting is GBP; most suppliers bill USD or EUR. Converting at whatever
 * today's rate happens to be means last March's margin changes every time
 * somebody opens the screen — which destroys the only thing the number is for.
 *
 * So a rate is a stored fact with a date. `rateFor` takes the rate on that day
 * or the most recent one before it, and returns null when it has none.
 * **Null is not 1.0.** A missing USD rate silently treated as parity turns
 * $500 into £500, and the figure is plausible enough that nobody checks.
 */

export const REPORTING_CURRENCY = "GBP";

export const SetFxRateInput = z.object({
  day: z.date(),
  base: z.string().trim().toUpperCase().length(3),
  quote: z.string().trim().toUpperCase().length(3).default(REPORTING_CURRENCY),
  /** Units of quote per one unit of base — 0.785 for USD→GBP. */
  rate: z.number().positive().max(1000),
  source: z.string().trim().max(40).default("manual"),
});
export type SetFxRateInput = z.input<typeof SetFxRateInput>;

/** `2026-09-13` — what the `date` column holds. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Records a rate, replacing that day's if one is already stored. */
export async function setFxRate(db: Db, organisationId: string, input: SetFxRateInput): Promise<void> {
  const v = SetFxRateInput.parse(input);
  const rateMicros = Math.round(v.rate * 1_000_000);
  await db
    .insert(schema.fxRates)
    .values({ organisationId, day: dayKey(v.day), base: v.base, quote: v.quote, rateMicros, source: v.source })
    .onConflictDoUpdate({
      target: [schema.fxRates.organisationId, schema.fxRates.day, schema.fxRates.base, schema.fxRates.quote],
      set: { rateMicros, source: v.source, updatedAt: new Date() },
    });
}

/**
 * The rate to use for a given day, or null.
 *
 * Falls back to the most recent rate *before* that day, never a later one: a
 * cost incurred in March cannot be converted at April's rate, because April
 * did not exist yet when the money moved.
 */
export async function rateFor(
  db: Db,
  organisationId: string,
  base: string,
  at: Date = new Date(),
  quote: string = REPORTING_CURRENCY,
): Promise<number | null> {
  const a = base.trim().toUpperCase();
  const b = quote.trim().toUpperCase();
  if (a === b) return 1_000_000;

  const [row] = await db
    .select({ rateMicros: schema.fxRates.rateMicros })
    .from(schema.fxRates)
    .where(
      and(
        eq(schema.fxRates.organisationId, organisationId),
        eq(schema.fxRates.base, a),
        eq(schema.fxRates.quote, b),
        lte(schema.fxRates.day, dayKey(at)),
      ),
    )
    .orderBy(desc(schema.fxRates.day))
    .limit(1);

  return row ? row.rateMicros : null;
}

/**
 * Every rate the register needs, in one read.
 *
 * The Profit screen touches dozens of rows across a handful of currencies;
 * asking the database per row would be a query per line for no reason. Returns
 * a map of currency → micros, with currencies it has no rate for simply
 * absent, so the caller can list them as needing one.
 */
export async function ratesForCurrencies(
  db: Db,
  organisationId: string,
  currencies: readonly string[],
  at: Date = new Date(),
): Promise<Record<string, number>> {
  const wanted = [...new Set(currencies.map((c) => c.trim().toUpperCase()))];
  const out: Record<string, number> = {};
  for (const currency of wanted) {
    const micros = await rateFor(db, organisationId, currency, at);
    if (micros !== null) out[currency] = micros;
  }
  return out;
}

/** The currencies in the register that have no rate on or before `at`. */
export function missingRates(currencies: readonly string[], rates: Record<string, number>): string[] {
  return [...new Set(currencies.map((c) => c.trim().toUpperCase()))]
    .filter((c) => c !== REPORTING_CURRENCY && rates[c] === undefined)
    .sort();
}
