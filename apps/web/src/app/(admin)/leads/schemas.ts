import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const LEAD_STATUSES = schema.leadStatusEnum.enumValues;

/** The statuses a person may set by hand; `converted` is reached only through "Convert to client". */
export const MANUAL_LEAD_STATUSES = LEAD_STATUSES.filter((status) => status !== "converted");

export const LEAD_STATUS_LABEL: Record<(typeof LEAD_STATUSES)[number], string> = {
  new: "New",
  contacted: "Contacted",
  converted: "Converted",
  lost: "Lost",
};

/** A lead's source, in the words of where it came from. Unknown sources are shown as typed. */
export const LEAD_SOURCE_LABEL: Record<string, string> = {
  website: "Website form",
  signup: "Self-serve sign-up",
  manual: "Added by hand",
  referral: "Referral",
};

export const UpdateLeadStatusSchema = z.object({
  leadId: z.string().uuid(),
  status: z.enum(MANUAL_LEAD_STATUSES as [string, ...string[]]),
});

export const ConvertLeadSchema = z.object({
  leadId: z.string().uuid(),
  name: z.string().trim().max(200).optional(),
  // "No package" posts an empty string, which has to become undefined before the uuid rule runs.
  packageId: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v : undefined))
    .pipe(z.string().uuid("Choose a package or leave it blank").optional()),
});
export type ConvertLeadValues = z.input<typeof ConvertLeadSchema>;

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
