import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * A case whose work is finished. Kept here so the default list view, the SLA
 * badge and the detail screen all agree on what "still open" means.
 */
export const CLOSED_STATUSES = ["resolved", "closed"] as const;

/** True when the case is finished, whatever the caller's status type is. */
export function isClosed(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/**
 * `?status=all` drops the status condition entirely, so a case that was closed
 * last week is still reachable from the list rather than only from a link. No
 * status param at all keeps the default "Open only" view.
 */
export const ALL_STATUSES = "all";

/**
 * The filter bar's query string. Every field is optional; the page validates
 * them one at a time and drops anything unrecognised, so a hand-edited URL
 * narrows the list wrongly at worst — it never 500s the screen.
 */
export const CASE_FILTER_SCHEMA = z.object({
  status: z.union([z.literal(ALL_STATUSES), z.enum(schema.ticketStatusEnum.enumValues)]).optional(),
  severity: z.enum(schema.severityEnum.enumValues).optional(),
  assignee: z.string().min(1).optional(),
  clientId: z.string().uuid().optional(),
});
