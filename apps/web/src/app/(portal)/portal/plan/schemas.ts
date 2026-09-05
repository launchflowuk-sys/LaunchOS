import { SUBSCRIPTION_CHANGE_KINDS } from "@launchos/core";
import { z } from "zod";

/**
 * Local to this module rather than shared — every module in this app defines
 * its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const PlanChangeSchema = z.object({
  kind: z.enum(SUBSCRIPTION_CHANGE_KINDS, { message: "Choose what you would like to change" }),
  message: z.string().trim().min(1, "Tell us a little about why").max(4000),
});

/** The first Zod issue, which is the one for the field the client just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
