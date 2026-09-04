import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const PAYMENT_PROVIDERS = ["bank", "cash", "stripe", "other"] as const;

/**
 * The form takes pounds because that is what a bank statement shows; the
 * database stores integer pence. The single rounding happens in the action.
 */
export const RecordPaymentSchema = z.object({
  clientId: z.string().uuid("Choose a client"),
  invoiceId: z.string().uuid().optional(),
  amountPounds: z.coerce.number().positive("Enter an amount above zero").max(1_000_000),
  provider: z.enum(PAYMENT_PROVIDERS),
  providerRef: z.string().trim().max(200).optional(),
});
