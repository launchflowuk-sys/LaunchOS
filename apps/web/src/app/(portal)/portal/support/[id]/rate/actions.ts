"use server";

import { CsatRefused, rateTicket } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { type ActionResult, firstIssue, RateSchema } from "../../schemas";

/**
 * Records the client's score for a resolved case.
 *
 * `rateTicket` re-checks everything that matters — the case belongs to a
 * client this user is an active portal user of, it is visible to them, it is
 * resolved — so a ticket id posted from outside the form gets the same
 * refusal the page would have shown. One rating per case: sending again
 * replaces the score and the comment.
 */
export async function ratePortalTicket(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();

  const rawComment = formData.get("comment");
  const parsed = RateSchema.safeParse({
    ticketId: formData.get("ticketId"),
    score: formData.get("score"),
    ...(typeof rawComment === "string" && rawComment.trim().length > 0 ? { comment: rawComment } : {}),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Choose a score and try again") };
  const { ticketId, score, comment } = parsed.data;

  try {
    await rateTicket(getDb(), session.organisationId, {
      ticketId,
      actorUserId: session.userId,
      score,
      ...(comment ? { comment } : {}),
    });
  } catch (error) {
    // Core's refusals are written for the client: "still open", "could not be found".
    if (error instanceof CsatRefused) return { status: "error", message: error.message };
    console.error("portal rating failed", error);
    return { status: "error", message: "Your rating could not be saved. Please try again." };
  }

  revalidatePath(`/portal/support/${ticketId}/rate`);
  revalidatePath(`/portal/support/${ticketId}`);
  revalidatePath(`/cases/${ticketId}`);
  revalidatePath("/team/health");
  return { status: "ok", id: ticketId };
}
