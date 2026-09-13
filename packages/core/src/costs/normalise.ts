/**
 * Turning a register row into a comparable number.
 *
 * Every supplier bills on its own cycle and in its own currency, so the rows
 * cannot be added up as they stand: a £120 yearly domain and a £12 monthly
 * mailbox are not the same cost, and `sum(renewal_price)` says they are.
 *
 * A leaf module with no imports — pure arithmetic, so the awkward cases
 * (two-year terms, weekly billing, the reverse charge) are tested without a
 * database.
 *
 * **All amounts are integer minor units** — pence for GBP, cents for USD —
 * and stay that way. A float for money accumulates error that nobody can
 * account for when the total is compared against a bank statement.
 */

export type VatTreatment = "standard" | "reverse_charge" | "exempt" | "none";

/** The parts of a register row the arithmetic needs, and nothing else. */
export interface CostLike {
  /** In the supplier's own currency, minor units, for one billing period. */
  renewalPrice: number;
  currencyCode: string;
  billingPeriod: number;
  /** `day` | `week` | `month` | `year`, as the supplier states it. */
  billingPeriodUnit: string;
  vatTreatment: VatTreatment;
  /** The supplier's word for it. `cancelled` is not a forward cost. */
  status: string;
}

/**
 * How many of a unit make a month.
 *
 * A week is not four: 52 weeks a year is 4.333 a month, and rounding it to 4
 * loses a month's cost every three years. Daily is 365/12 for the same reason.
 */
const MONTHS_PER_UNIT: Record<string, number> = {
  day: 1 / (365 / 12),
  week: 1 / (52 / 12),
  month: 1,
  year: 12,
};

/** A subscription that has stopped is not a cost going forward. */
function isForwardCost(status: string): boolean {
  return status.trim().toLowerCase() !== "cancelled";
}

/**
 * What this row costs in a month, in its own currency's minor units.
 *
 * Zero — not NaN, not a throw — for a period this cannot make sense of. A
 * register is filled in by a person and synced from APIs that change; a single
 * malformed row must not take the whole Profit screen down with it. The row is
 * still listed, so a zero where a number belongs is visible.
 */
export function monthlyMinor(cost: CostLike): number {
  if (!isForwardCost(cost.status)) return 0;
  const months = MONTHS_PER_UNIT[cost.billingPeriodUnit.trim().toLowerCase()];
  if (months === undefined) return 0;
  const periods = Number(cost.billingPeriod);
  if (!Number.isFinite(periods) || periods <= 0) return 0;
  const span = months * periods;
  if (span <= 0) return 0;
  return Math.round(cost.renewalPrice / span);
}

/**
 * What this row costs in a year.
 *
 * Derived from the period directly rather than as `monthlyMinor * 12`: a
 * yearly £120.01 divided by twelve and multiplied back is £120.00, and a
 * register that cannot restate its own input is one nobody trusts.
 */
export function yearlyMinor(cost: CostLike): number {
  if (!isForwardCost(cost.status)) return 0;
  const months = MONTHS_PER_UNIT[cost.billingPeriodUnit.trim().toLowerCase()];
  if (months === undefined) return 0;
  const periods = Number(cost.billingPeriod);
  if (!Number.isFinite(periods) || periods <= 0) return 0;
  const span = months * periods;
  if (span <= 0) return 0;
  return Math.round((cost.renewalPrice * 12) / span);
}

/**
 * The net amount, from what the register stores.
 *
 * The register always stores net — what the supplier charges before any VAT.
 * This exists as a named function rather than as nothing so the assumption is
 * stated in one place and can be changed in one place.
 */
export function netFromStored(storedMinor: number, _treatment: VatTreatment): number {
  return storedMinor;
}

/**
 * The gross amount — what actually leaves the bank.
 *
 * Only `standard` adds anything. Under the reverse charge no VAT is paid to
 * the supplier at all, so gross and net are the same figure; treating it as
 * net-plus-20% overstates the cost by a fifth, which on Hetzner is the
 * difference between a real margin and an imagined one.
 */
export function grossFromNet(netMinor: number, treatment: VatTreatment, vatRatePercent: number): number {
  if (treatment !== "standard") return netMinor;
  return netMinor + Math.round((netMinor * vatRatePercent) / 100);
}

/**
 * One currency into another, at a stored rate.
 *
 * Throws when there is no rate. That is deliberate and it is the whole point:
 * a missing rate silently treated as 1.0 turns $500 of Anthropic spend into
 * £500 of cost, and the number looks plausible enough that nobody checks it.
 * The caller decides what to do — show "rate needed" rather than a wrong
 * figure.
 */
export function convert(amountMinor: number, from: string, to: string, rateMicros: number): number {
  const a = from.trim().toUpperCase();
  const b = to.trim().toUpperCase();
  if (a === b) return amountMinor;
  if (!Number.isFinite(rateMicros) || rateMicros <= 0) {
    throw new Error(`no rate for ${a}->${b}`);
  }
  return Math.round((amountMinor * rateMicros) / 1_000_000);
}
