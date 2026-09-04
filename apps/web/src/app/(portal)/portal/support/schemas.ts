import { z } from "zod";

/**
 * Local to this module rather than shared — every module in this app defines
 * its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * A client cannot self-declare `critical`. That severity drives the tightest
 * SLA and the escalation path, so it stays a triage decision made by staff or
 * by the Support Triage agent, never a dropdown a client can pick.
 */
export const PORTAL_SEVERITIES = ["low", "medium", "high"] as const;

export const NewTicketSchema = z.object({
  subject: z.string().trim().min(1, "Give the request a subject").max(200),
  body: z.string().trim().min(1, "Tell us what has happened").max(8000),
  severity: z.enum(PORTAL_SEVERITIES),
});

export const ReplySchema = z.object({
  ticketId: z.string().uuid(),
  body: z.string().trim().min(1, "Write something first").max(8000),
});

/** The first Zod issue, which is the one the field the client just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
