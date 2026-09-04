"use server";

import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

const DecisionInput = z.object({
  approvalId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

async function decide(formData: FormData, status: "approved" | "rejected"): Promise<ActionResult> {
  // Server Actions accept direct POSTs, so authorise here and scope every
  // query by the caller's organisation.
  const session = await requireAdmin();
  const raw = formData.get("note");
  const parsed = DecisionInput.safeParse({
    approvalId: formData.get("approvalId"),
    ...(typeof raw === "string" && raw.trim().length > 0 ? { note: raw } : {}),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid decision" };
  }
  const { approvalId, note } = parsed.data;

  const where = and(
    eq(schema.approvals.id, approvalId),
    eq(schema.approvals.organisationId, session.organisationId),
    eq(schema.approvals.status, "pending"),
  );

  try {
    const [before] = await getDb().select().from(schema.approvals).where(where);
    if (!before) return { status: "error", message: "That approval is not waiting for a decision." };

    if (before.runId) {
      // The row is deliberately left `pending` here. `resumeAgent` refuses to
      // resume an approval that is already decided, so pre-stamping it would
      // strand the run: the kernel stamps `status`, `decided_by` and
      // `decision_note` itself as the first thing it does on resume.
      await sendJob(
        "agent.resume",
        {
          organisationId: session.organisationId,
          runId: before.runId,
          approvalId,
          decision: status,
          ...(note ? { note } : {}),
          decidedByUserId: session.userId,
        },
        // One resume per approval, however many times the button is pressed.
        { singletonKey: `resume:${approvalId}` },
      );
      await recordAudit(getDb(), session.organisationId, {
        actorKind: "user",
        actorId: session.userId,
        action: `approval.${status}_queued`,
        targetType: "approval",
        targetId: approvalId,
        before,
      });
    } else {
      // Nothing will resume an approval with no run behind it (a Plan 5
      // invoice send, say), so the decision is recorded here.
      const [after] = await getDb()
        .update(schema.approvals)
        .set({
          status,
          decidedBy: session.userId,
          decidedAt: new Date(),
          decisionNote: note ?? null,
          updatedAt: new Date(),
        })
        .where(where)
        .returning();

      await recordAudit(getDb(), session.organisationId, {
        actorKind: "user",
        actorId: session.userId,
        action: `approval.${status}`,
        targetType: "approval",
        targetId: approvalId,
        before,
        after,
      });
    }

    revalidatePath("/approvals");
    revalidatePath("/");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function approveApproval(formData: FormData): Promise<ActionResult> {
  return decide(formData, "approved");
}

export async function rejectApproval(formData: FormData): Promise<ActionResult> {
  return decide(formData, "rejected");
}
