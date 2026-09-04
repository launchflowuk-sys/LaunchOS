import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * Three letters, not three characters. `length(3)` accepted `12X` and `G B`,
 * which `Intl.NumberFormat` throws on — see the note on `CurrencyCode` in
 * `packages/core/src/ads/accounts.ts`, which is the boundary that matters and
 * carries the same rule.
 */
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a three-letter code");

export const AddAdAccount = z.object({
  clientId: z.string().uuid("Choose a client"),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().trim().min(1, "Account id is required").max(120),
  name: z.string().trim().min(1, "Name is required").max(200),
  currency,
});

export const EditAdAccount = z.object({
  adAccountId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(200),
  currency,
  status: z.enum(["active", "paused", "disconnected"]),
});

export const AdReportRef = z.object({ adReportId: z.string().uuid() });

/**
 * A form field is a string or a `File`; the cast the add action used to do was
 * a lie for a multipart POST carrying a file, and `.toUpperCase()` on a `File`
 * threw a `TypeError` outside the try block — a Next 500 instead of a toast.
 */
export function textField(value: FormDataEntryValue | null, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
