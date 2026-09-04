"use server";

import { replyToConversation } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, ReplyInput } from "./schemas";

/**
 * Core's own strings name tables, ids and internal helpers; they belong in the
 * server log, not in a toast. These are the two a staff member can act on.
 */
function replyError(error: unknown): ActionResult {
  console.error("inbox reply failed", error);
  const raw = error instanceof Error ? error.message : "";
  if (raw.includes("participant email")) {
    return { status: "error", message: "This thread has no email address to reply to. Answer it on the case instead." };
  }
  if (raw.includes("support email identity")) {
    return { status: "error", message: "This client has no support address yet. Add one on their client screen, then try again." };
  }
  if (raw.includes("visible to the client")) {
    return { status: "error", message: "This case is internal. Share it with the client on the case screen before replying." };
  }
  return { status: "error", message: "That reply could not be sent. Please try again." };
}

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
      portalUrl: env.APP_URL,
    });
    revalidatePath(`/inbox/${parsed.data.conversationId}`);
    revalidatePath("/inbox");
    return { status: "ok" };
  } catch (error) {
    return replyError(error);
  }
}

export async function sendThreadReply(formData: FormData): Promise<ActionResult> {
  return reply(formData, false);
}

export async function addInternalNote(formData: FormData): Promise<ActionResult> {
  return reply(formData, true);
}
