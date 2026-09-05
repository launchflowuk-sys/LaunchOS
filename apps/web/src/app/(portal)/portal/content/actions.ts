"use server";

import { ContentRefused, suggestContentItem } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { installWebEnqueue } from "@/lib/queue";
import { type ActionResult, firstIssue, SuggestPostSchema } from "./schemas";

/**
 * Suggest a post.
 *
 * `clientId` and the user come from the session, never the form: a portal user
 * can only add an idea to their own client's list. It lands as a draft for
 * LaunchFlow to shape, schedule and approve — nothing is published from here.
 */
export async function suggestPostAction(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  installWebEnqueue();

  const parsed = SuggestPostSchema.safeParse({
    text: formData.get("text"),
    linkUrl: formData.get("linkUrl") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };

  try {
    const item = await suggestContentItem(getDb(), session.organisationId, {
      clientId: session.clientId,
      actorUserId: session.userId,
      text: parsed.data.text,
      ...(parsed.data.linkUrl ? { linkUrl: parsed.data.linkUrl } : {}),
    });
    revalidatePath("/portal/content");
    revalidatePath("/content");
    return { status: "ok", id: item.id };
  } catch (error) {
    if (error instanceof ContentRefused) return { status: "error", message: error.message };
    console.error("portal post suggestion failed", error);
    return { status: "error", message: "That could not be sent. Please try again." };
  }
}
