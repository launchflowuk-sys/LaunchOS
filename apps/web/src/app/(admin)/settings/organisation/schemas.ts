import { z } from "zod";

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * An emptied input means "clear this column", not "leave it alone" — a supplier
 * that de-registers for VAT has to be able to take its VAT number off its
 * invoices — so every blank becomes `null` rather than `undefined`.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null));

export const UpdateOrganisationSchema = z.object({
  legalName: optionalText(200),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  postcode: optionalText(20),
  country: optionalText(60),
  vatNumber: optionalText(40),
  companyNumber: optionalText(40),
  invoiceFooter: optionalText(1000),
});

export const SUPPLIER_FIELDS = [
  "legalName",
  "addressLine1",
  "addressLine2",
  "city",
  "postcode",
  "country",
  "vatNumber",
  "companyNumber",
  "invoiceFooter",
] as const;

export type SupplierFieldsRead =
  | { status: "ok"; values: Record<string, unknown> }
  | { status: "incomplete"; missing: string[] };

/**
 * Reads the whole supplier form, refusing a body that is missing fields.
 *
 * "Present and empty" and "absent" mean different things here. The form posts
 * every field, so an empty one is a deliberate clear. A truncated submit — a
 * hand-rolled POST, a client that dropped inputs — is not: mapping its missing
 * fields to `""` would wipe the VAT number and the address and report success.
 * `formData.has` tells the two apart; only the first is accepted.
 */
export function readSupplierFields(formData: FormData): SupplierFieldsRead {
  const missing = SUPPLIER_FIELDS.filter((field) => !formData.has(field));
  if (missing.length > 0) return { status: "incomplete", missing: [...missing] };
  return {
    status: "ok",
    values: Object.fromEntries(SUPPLIER_FIELDS.map((field) => [field, formData.get(field) ?? ""])),
  };
}
