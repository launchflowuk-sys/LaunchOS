import { date, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

/**
 * One day's exchange rate, stored so a past month always reads the same.
 *
 * Reporting is in GBP; half the suppliers bill in USD. Converting at
 * "today's rate" whenever a screen loads means last March's profit changes
 * every time somebody looks at it, which makes the figure useless for the one
 * thing it is for — comparing months.
 *
 * So the rate is a stored fact with a date on it. A cost incurred on a given
 * day is converted at that day's rate, for ever. Nothing recalculates.
 *
 * `rateMicros` rather than a float: 1.2745 is stored as 1_274_500. Binary
 * floating point cannot hold a decimal rate exactly, and a rate that drifts in
 * the seventh place is a penny of error per hundred pounds that nobody can
 * account for.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    ...tenantColumns(),
    /** The day the rate applies to, in UTC. */
    day: date("day").notNull(),
    /** ISO 4217, upper case — the currency being converted from. */
    base: text("base").notNull(),
    /** ISO 4217, upper case — the currency being converted to. Always GBP today. */
    quote: text("quote").notNull(),
    /** Units of `quote` per one unit of `base`, times 1,000,000. */
    rateMicros: integer("rate_micros").notNull(),
    /** `manual`, or the name of whatever fetched it. Kept so a bad rate can be traced. */
    source: text("source").default("manual").notNull(),
  },
  (t) => [
    uniqueIndex("fx_rates_day").on(t.organisationId, t.day, t.base, t.quote),
    index("fx_rates_lookup").on(t.organisationId, t.base, t.quote, t.day),
  ],
);
