import { z } from "zod";

/**
 * Every admin module declares its own `ActionResult` with this shape so the
 * modules stay independently editable (see `tasks/schemas.ts`). It lives here
 * rather than in `actions.ts` because a `"use server"` file is only permitted
 * to export async functions.
 */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

export const ReplyInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(8000),
});
