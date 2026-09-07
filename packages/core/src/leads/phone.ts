/**
 * UK numbers, in one shape.
 *
 * The same person is `07700 900123` on a form, `+44 7700 900123` in a contact
 * card and `447700900123` from a provider. The suppression list only works if
 * all three are one row — a number Shoji has asked never to be contacted must
 * not slip through because the provider wrote it differently — so everything
 * that comes in is squared up before it is stored or compared.
 *
 * Anything that is not recognisably a UK number is returned trimmed of spaces
 * and punctuation rather than rejected: an unknown shape should still be
 * suppressible and still be storable, just not silently mangled.
 */
const UK_TRUNK_PREFIX = "0";
const UK_COUNTRY_CODE = "44";

export function normalisePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;

  // 00 44 … — the international prefix written the old way.
  const withoutIdd = digits.startsWith("00") ? digits.slice(2) : digits;

  if (withoutIdd.startsWith(UK_COUNTRY_CODE) && withoutIdd.length >= 12) {
    return `+${withoutIdd}`;
  }

  // 07700 900123 — the national form, which is the one people actually type.
  if (withoutIdd.startsWith(UK_TRUNK_PREFIX) && withoutIdd.length === 11) {
    return `+${UK_COUNTRY_CODE}${withoutIdd.slice(1)}`;
  }

  // Already international, just written without its plus.
  if (hasPlus) return `+${withoutIdd}`;

  return withoutIdd;
}
