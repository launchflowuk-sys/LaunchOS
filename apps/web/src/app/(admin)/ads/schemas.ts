import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const AddAdAccount = z.object({
  clientId: z.string().uuid("Choose a client"),
  platform: z.enum(["google", "meta"]),
  externalId: z.string().trim().min(1, "Account id is required").max(120),
  name: z.string().trim().min(1, "Name is required").max(200),
  currency: z.string().trim().length(3, "Currency must be a three-letter code"),
});

export const AdReportRef = z.object({ adReportId: z.string().uuid() });
