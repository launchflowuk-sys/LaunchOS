import { z } from "zod";

/**
 * The Progress page's contract. A `"use server"` module may only export async
 * functions, and the review card is a client component that needs these.
 * Nothing here may import `@launchos/core`.
 */

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * The `payload.action` a client review carries.
 *
 * The portal matches on this rather than on `approvals.kind` deliberately.
 * `payload->>'action'` is already how `subscription_change` and the invoice
 * send are found — a partial unique index cannot test an enum, so every
 * approval that needs identifying writes `action` alongside `kind` — and it
 * means this page keeps working whatever the enum value ends up being called.
 */
export const CLIENT_REVIEW_ACTION = "client_review";

export const ReviewDecisionSchema = z.object({
  approvalId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
