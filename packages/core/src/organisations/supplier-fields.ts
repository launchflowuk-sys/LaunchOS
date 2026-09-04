import { z } from "zod";

/**
 * Format checks for the supplier fields that end up printed on a legal
 * document.
 *
 * These live in core rather than in the settings form so that every writer —
 * the form today, an API or an agent tool tomorrow — gets the same rule. A
 * fat-fingered registration number is not caught by a length cap: it is saved
 * without complaint and then printed on every invoice the agency raises until
 * a client's accountant fails to validate it and asks for the batch to be
 * reissued.
 *
 * Blank still clears the column — a supplier that de-registers for VAT has to
 * be able to take its number off its invoices — so only non-empty values are
 * checked.
 */

/** UK: `GB` + 9 digits, or 12 for a branch trader. */
const GB_VAT = /^GB\d{9}(\d{3})?$/;
/** Everything else: a two-letter country code plus its registration body. */
const EU_VAT = /^[A-Z]{2}[A-Z0-9]{2,12}$/;

/**
 * Takes an uppercased, trimmed value and says whether it is shaped like a VAT
 * registration.
 *
 * Two deliberate details. A GB-prefixed number is checked against the GB shape
 * *first*, because the generic pattern would happily accept `GB12345678` — the
 * eight-digit typo that is the most likely way to get this wrong in the UK.
 * And a value written with spaces has to start with its two-letter country
 * code: `GB 123 456 789` is a formatting of a real number, while
 * `VAT GB123456789` is a pasted label that the generic pattern would otherwise
 * read as country code "VA".
 */
export function isVatNumberShaped(value: string): boolean {
  const parts = value.split(/\s+/);
  if (parts.length > 1 && parts[0]!.length !== 2) return false;
  const compact = parts.join("");
  return compact.startsWith("GB") ? GB_VAT.test(compact) : EU_VAT.test(compact);
}

/**
 * A supplier field that is either blank (clearing the column) or has to pass
 * `check` once normalised. `store` is what actually reaches the column.
 */
function optionalSupplierField(
  normalise: (value: string) => string,
  check: (value: string) => boolean,
  message: string,
  store: (value: string) => string = (value) => value,
) {
  return z
    .string()
    .transform(normalise)
    .refine((value) => value.length === 0 || check(value), message)
    .transform((value) => (value.length === 0 ? null : store(value)))
    .nullish();
}

/** Stored compact — `GB 123 456 789` and `gb123456789` are the same registration. */
export const VatNumberField = optionalSupplierField(
  (value) => value.trim().toUpperCase(),
  isVatNumberShaped,
  'VAT number must be a two-letter country code followed by its registration, e.g. "GB123456789"',
  (value) => value.replace(/\s+/g, ""),
);

export const CountryField = optionalSupplierField(
  (value) => value.trim().toUpperCase(),
  (value) => /^[A-Z]{2}$/.test(value),
  'Country must be a two-letter ISO country code, e.g. "GB"',
);

export const PostcodeField = optionalSupplierField(
  (value) => value.trim(),
  (value) => value.length >= 3 && value.length <= 10,
  "Postcode must be between 3 and 10 characters",
);
