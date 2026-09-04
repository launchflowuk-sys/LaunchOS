"use server";

import { replyToConversation } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/**
 * Every admin module declares its own `ActionResult` with this shape so the
 * modules stay independently editable (see `tasks/schemas.ts`).
 */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

const ReplyInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(8000),
});

/**
 * A staff member sending from the Inbox is a human action, so it does not go
 * through the approval gate (spec section 4, Outbound email). It is still
 * audited by `replyToConversation` and still leaves through the same
 * `outbound.message` job an agent's approved reply would.
 */
async function reply(formData: FormData, internal: boolean): Promise<ActionResult> {
  // Server Actions accept direct POSTs, so authorise and re-validate here.
  const session = await requireAdmin();
  const parsed = ReplyInput.safeParse({
    conversationId: formData.get("conversationId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid message" };
  }

  // replyToConversation emits `message.queued`; without this the event is
  // dropped and the reply never reaches a mail server.
  installWebEnqueue();

  try {
    await replyToConversation(getDb(), session.organisationId, {
      conversationId: parsed.data.conversationId,
      body: parsed.data.body,
      actorKind: "user",
      actorId: session.userId,
      internal,
    });
    revalidatePath(`/inbox/${parsed.data.conversationId}`);
    revalidatePath("/inbox");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function sendThreadReply(formData: FormData): Promise<ActionResult> {
  return reply(formData, false);
}

export async function addInternalNote(formData: FormData): Promise<ActionResult> {
  return reply(formData, true);
}
