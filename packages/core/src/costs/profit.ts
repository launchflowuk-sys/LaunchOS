import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { vatRateForOrganisation } from "../billing/vat-rate.js";
import { missingRates, ratesForCurrencies, REPORTING_CURRENCY } from "./fx.js";
import { convert, grossFromNet, type VatTreatment } from "./normalise.js";
import { BUSINESS_LABELS, listRegister, type CostBusiness, type RegisterEntry } from "./register.js";

/**
 * What LaunchFlow makes, and what it spends to make it.
 *
 * Ex-VAT with the gross shown alongside, which is Shoji's call and the correct
 * one: VAT charged is not income and VAT paid is reclaimable, so a margin
 * computed on gross figures is simply wrong. The gross is kept beside it so a
 * number on screen can still be matched against the bank.
 *
 * **This is deliberately incomplete and says so.** Only the register is in
 * here — subscriptions and fixed costs. No AI tokens, no images, no
 * screenshots, no email or message costs, because the usage ledger does not
 * exist yet. `complete: false` is returned so every screen must state it
 * rather than presenting a margin that quietly ignores the variable cost.
 */

export interface SupplierLine {
  supplier: string;
  name: string;
  business: CostBusiness;
  businessLabel: string;
  /** GBP pence, ex-VAT. */
  monthlyNetPence: number;
  yearlyNetPence: number;
  /** GBP pence, what actually leaves the bank. */
  monthlyGrossPence: number;
  currencyCode: string;
  vatTreatment: VatTreatment;
  /** True when this row is priced at zero and therefore contributing nothing. */
  unpriced: boolean;
  /** True when the row's currency has no stored rate, so it could not be converted. */
  rateMissing: boolean;
}

export interface ProfitReport {
  /** `2026-09`. */
  month: string;
  /** Money collected this calendar month, GBP pence, ex-VAT where VAT was charged. */
  revenueNetPence: number;
  /** What was invoiced gross — matches the bank. */
  revenueGrossPence: number;
  /** Register cost for the month, GBP pence, ex-VAT. */
  costNetPence: number;
  costGrossPence: number;
  /** revenue − cost, ex-VAT. Can be negative; that is information, not an error. */
  marginNetPence: number;
  /** Annualised from the monthly figures. */
  yearlyCostNetPence: number;
  /** Rolling twelve months of collected revenue. */
  yearlyRevenueNetPence: number;
  /** Only the businesses that actually have cost against them. */
  costByBusiness: { business: CostBusiness; label: string; monthlyNetPence: number }[];
  lines: SupplierLine[];
  /** Currencies in the register with no stored FX rate. Their rows are excluded from totals. */
  missingRateCurrencies: string[];
  /** Rows priced at zero — the register is not finished until this is empty. */
  unpricedCount: number;
  /**
   * False while the usage ledger is unbuilt. Every screen must say so: a
   * margin that silently omits the variable cost is worse than no margin.
   */
  complete: false;
  /** What is not counted, in words, for the screen to print. */
  excludes: readonly string[];
}

const EXCLUDES = [
  "AI tokens (Claude, OpenAI)",
  "generated images",
  "website screenshots",
  "email and message sends",
  "Stripe card fees",
] as const;

/** Money collected between two instants, net and gross, in GBP pence. */
async function collectedRevenue(db: Db, organisationId: string, from: Date, to: Date): Promise<{ net: number; gross: number }> {
  const [row] = await db
    .select({
      gross: sql<string>`coalesce(sum(${schema.invoices.totalPence}), 0)`,
      vat: sql<string>`coalesce(sum(${schema.invoices.vatPence}), 0)`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.status, "paid"),
        isNotNull(schema.invoices.paidAt),
        gte(schema.invoices.paidAt, from),
        lt(schema.invoices.paidAt, to),
      ),
    );
  const gross = Number(row?.gross ?? 0);
  const vat = Number(row?.vat ?? 0);
  // Net is gross less the VAT actually charged on those invoices, not gross
  // divided by 1.2 — some lines are zero-rated and dividing would understate.
  return { net: gross - vat, gross };
}

/**
 * The company's month.
 *
 * Costs are converted at the rate stored for the first of the month, so the
 * figure for a closed month never moves. A row in a currency with no rate is
 * left out of the totals and named in `missingRateCurrencies` — excluded
 * loudly rather than converted at a guess.
 */
export async function profitReport(db: Db, organisationId: string, now: Date = new Date()): Promise<ProfitReport> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [register, vatRate, revenue, yearRevenue] = await Promise.all([
    listRegister(db, organisationId),
    vatRateForOrganisation(db, organisationId),
    collectedRevenue(db, organisationId, monthStart, nextMonth),
    collectedRevenue(db, organisationId, yearStart, nextMonth),
  ]);

  const currencies = register.map((row) => row.currencyCode);
  const rates = await ratesForCurrencies(db, organisationId, currencies, monthStart);
  const missing = missingRates(currencies, rates);

  const lines: SupplierLine[] = [];
  let costNet = 0;
  let costGross = 0;
  let yearlyCostNet = 0;
  const byBusiness = new Map<CostBusiness, number>();

  for (const row of register) {
    const rateMissing = row.currencyCode.toUpperCase() !== REPORTING_CURRENCY && rates[row.currencyCode.toUpperCase()] === undefined;
    const line = toLine(row, rates, vatRate, rateMissing);
    lines.push(line);
    if (rateMissing) continue;
    costNet += line.monthlyNetPence;
    costGross += line.monthlyGrossPence;
    yearlyCostNet += line.yearlyNetPence;
    byBusiness.set(row.business, (byBusiness.get(row.business) ?? 0) + line.monthlyNetPence);
  }

  const month = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;

  return {
    month,
    revenueNetPence: revenue.net,
    revenueGrossPence: revenue.gross,
    costNetPence: costNet,
    costGrossPence: costGross,
    marginNetPence: revenue.net - costNet,
    yearlyCostNetPence: yearlyCostNet,
    yearlyRevenueNetPence: yearRevenue.net,
    costByBusiness: [...byBusiness.entries()]
      .filter(([, pence]) => pence > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([business, monthlyNetPence]) => ({ business, label: BUSINESS_LABELS[business], monthlyNetPence })),
    lines: lines.sort((a, b) => b.monthlyNetPence - a.monthlyNetPence),
    missingRateCurrencies: missing,
    unpricedCount: register.filter((row) => row.renewalPrice === 0 && row.status !== "cancelled").length,
    complete: false,
    excludes: EXCLUDES,
  };
}

function toLine(row: RegisterEntry, rates: Record<string, number>, vatRate: number, rateMissing: boolean): SupplierLine {
  const currency = row.currencyCode.toUpperCase();
  const micros = currency === REPORTING_CURRENCY ? 1_000_000 : rates[currency] ?? 0;

  const monthlyNetPence = rateMissing ? 0 : convert(row.monthlyMinor, currency, REPORTING_CURRENCY, micros);
  const yearlyNetPence = rateMissing ? 0 : convert(row.yearlyMinor, currency, REPORTING_CURRENCY, micros);

  return {
    supplier: row.supplier,
    name: row.name,
    business: row.business,
    businessLabel: BUSINESS_LABELS[row.business],
    monthlyNetPence,
    yearlyNetPence,
    monthlyGrossPence: grossFromNet(monthlyNetPence, row.vatTreatment, vatRate),
    currencyCode: currency,
    vatTreatment: row.vatTreatment,
    unpriced: row.renewalPrice === 0 && row.status !== "cancelled",
    rateMissing,
  };
}
