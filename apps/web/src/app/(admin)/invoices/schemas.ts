import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "void"] as const;

/** A hand-typed query string must narrow the list, never break the page. */
export const InvoiceStatusFilter = z.enum(INVOICE_STATUSES).optional().catch(undefined);

export const ClientRef = z.object({ clientId: z.string().uuid("Choose a client") });
export const InvoiceRef = z.object({ invoiceId: z.string().uuid() });
export const ApprovalRef = z.object({ approvalId: z.string().uuid() });
