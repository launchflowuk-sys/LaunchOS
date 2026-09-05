/**
 * Money conversion for the ad providers.
 *
 * Everything downstream (`ad_metric_snapshots.spend_pence`,
 * `conversion_value_pence`) is whole minor units of the account's own currency,
 * so a GBP account stores pence and a USD account stores cents. The column
 * names say pence because the one organisation running today bills in GBP;
 * `AdAccountSummary.currency` is what actually says which currency the integer
 * is in.
 */

/** Provider JSON puts int64 fields in strings and float fields in numbers. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Google Ads reports money in micros: 1,000,000 micros is one unit of the
 * account currency, so one minor unit is 10,000 micros.
 */
export function microsToMinorUnits(micros: number): number {
  return Math.round(micros / 10_000);
}

/** A float in major units (Google's `conversions_value`) to whole minor units. */
export function unitsToMinorUnits(units: number): number {
  return Math.round(units * 100);
}

/**
 * A decimal *string* in major units to whole minor units, half-up.
 *
 * Meta returns spend as `"123.45"`. `Math.round(Number("0.145") * 100)` is 14,
 * not 15, because the float is a hair under — so the digits are read directly
 * rather than routed through a multiplication.
 */
export function decimalToMinorUnits(value: unknown): number {
  if (typeof value === "number") return unitsToMinorUnits(value);
  if (typeof value !== "string") return 0;
  const match = /^\s*(-?)(\d*)(?:\.(\d+))?\s*$/.exec(value);
  if (!match) return unitsToMinorUnits(toNumber(value));
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] ?? "";
  const frac = match[3] ?? "";
  if (whole === "" && frac === "") return 0;
  const minor = Number(whole === "" ? "0" : whole) * 100 + Number(`${frac}00`.slice(0, 2));
  const roundUp = Number(frac[2] ?? "0") >= 5;
  return sign * (roundUp ? minor + 1 : minor);
}
