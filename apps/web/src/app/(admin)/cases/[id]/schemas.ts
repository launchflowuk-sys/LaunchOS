import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable. It lives here rather than in `actions.ts` because a
 * `"use server"` file is only permitted to export async functions.
 */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

export const TicketId = z.string().uuid();

export const StatusInput = z.object({
  ticketId: TicketId,
  status: z.enum(schema.ticketStatusEnum.enumValues),
});

export const AssignInput = z.object({
  ticketId: TicketId,
  assignedUserId: z.string().min(1).optional(),
});

export const EscalateInput = z.object({
  ticketId: TicketId,
  reason: z.string().trim().min(1).max(1000),
});

/**
 * No `conversationId`: the note's thread is derived from the org-scoped ticket
 * row, so a stale or hand-edited form cannot post an internal note onto a
 * different client's conversation while the case history says otherwise.
 */
export const NoteInput = z.object({
  ticketId: TicketId,
  body: z.string().trim().min(1).max(8000),
  /**
   * Which of the two things the composer is doing. `reply` reaches the client
   * — by email on an email thread, in the portal otherwise; `note` never
   * leaves LaunchOS. Defaulted rather than required so a form posted without
   * it is the safe one.
   */
  mode: z.enum(["reply", "note"]).default("note"),
});

export const VisibilityInput = z.object({
  ticketId: TicketId,
  clientVisible: z.enum(["true", "false"]).transform((v) => v === "true"),
});
