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

/** A missing input posts nothing at all, which Zod would reject as `undefined`. */
export function readSupplierFields(formData: FormData): Record<string, unknown> {
  return Object.fromEntries(SUPPLIER_FIELDS.map((field) => [field, formData.get(field) ?? ""]));
}
