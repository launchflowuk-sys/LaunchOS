"use server";

import { decideApproval, notifyOwner, recordActivity } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { type ActionResult, CLIENT_REVIEW_ACTION, firstIssue, ReviewDecisionSchema } from "./schemas";

/**
 * A client's answer to a review we invited them to give.
 *
 * Nothing here blocks anything, and that is the point: Shoji's rule is that a
 * client may approve a design but no task, step or milestone waits on them. An
 * approval that is never touched is a line in the Ops Brief after five days,
 * not a stall. So there is no "reject": the two doors are "happy with this",
 * which decides the approval, and "send a comment", which leaves it open and
 * puts their words on the timeline for us to act on.
 *
 * The approval is re-fetched by id **and by this client's id** before either
 * one writes: a portal user must not be able to decide somebody else's review
 * whatever they post.
 */

/** The pending review with this id that belongs to the signed-in client, or null. */
async function ownReview(organisationId: string, clientId: string, approvalId: string) {
  const [row] = await getDb()
    .select({ id: schema.approvals.id, title: schema.approvals.title, payload: schema.approvals.payload })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.id, approvalId),
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload} ->> 'action' = ${CLIENT_REVIEW_ACTION}`,
      sql`${schema.approvals.payload} ->> 'clientId' = ${clientId}`,
    ));
  return row ?? null;
}

function parse(formData: FormData) {
  const raw = formData.get("note");
  return ReviewDecisionSchema.safeParse({
    approvalId: formData.get("approvalId"),
    note: typeof raw === "string" && raw.trim().length > 0 ? raw : undefined,
  });
}

/** "Happy with this." Decides the approval and says so on the timeline. */
export async function approveClientReview(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  const parsed = parse(formData);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const { approvalId, note } = parsed.data;

  const review = await ownReview(session.organisationId, session.clientId, approvalId);
  if (!review) return { status: "error", message: "That review is no longer waiting for you." };

  try {
    const db = getDb();
    const result = await decideApproval(db, session.organisationId, {
      approvalId,
      decision: "approved",
      decidedByUserId: session.userId,
      ...(note ? { note } : {}),
    });
    if (result.alreadyDecided) return { status: "error", message: "Thank you — that one had already been answered." };

    await recordActivity(db, session.organisationId, {
      clientId: session.clientId,
      actorKind: "client",
      actorId: session.userId,
      kind: "project.client_review_approved",
      title: `${session.name} is happy with: ${review.title}`,
      ...(note ? { body: note } : {}),
    });
    await notifyOwner(db, session.organisationId, {
      kind: "project.client_review_approved",
      title: `${session.clientName} approved: ${review.title}`,
      ...(note ? { body: note } : {}),
      link: "/approvals",
    });
    revalidatePath("/portal/tasks");
    return { status: "ok", id: approvalId };
  } catch (error) {
    console.error("portal client review approval failed", error);
    return { status: "error", message: "That could not be saved. Please try again." };
  }
}

/**
 * "Send a comment." A comment is not a rejection, so the approval is left
 * pending: the client has said something, not refused something, and the work
 * carries on either way. Their words go on the timeline and into Shoji's bell.
 */
export async function commentOnClientReview(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  const parsed = parse(formData);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const { approvalId, note } = parsed.data;
  if (!note) return { status: "error", message: "Write a line or two and we will pick it up." };

  const review = await ownReview(session.organisationId, session.clientId, approvalId);
  if (!review) return { status: "error", message: "That review is no longer waiting for you." };

  try {
    const db = getDb();
    await recordActivity(db, session.organisationId, {
      clientId: session.clientId,
      actorKind: "client",
      actorId: session.userId,
      kind: "project.client_review_comment",
      title: `${session.name} commented on: ${review.title}`,
      body: note,
    });
    await notifyOwner(db, session.organisationId, {
      kind: "project.client_review_comment",
      title: `${session.clientName} commented on: ${review.title}`,
      body: note,
      link: "/approvals",
    });
    revalidatePath("/portal/tasks");
    return { status: "ok", id: approvalId };
  } catch (error) {
    console.error("portal client review comment failed", error);
    return { status: "error", message: "That could not be sent. Please try again." };
  }
}
