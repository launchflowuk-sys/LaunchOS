"use server";

import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const DecisionInput = z.object({
  approvalId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

async function decide(formData: FormData, status: "approved" | "rejected") {
  // Server Actions accept direct POSTs, so authorise here and scope every
  // query by the caller's organisation.
  const session = await requireAdmin();
  const { approvalId, note } = DecisionInput.parse({
    approvalId: formData.get("approvalId"),
    note: formData.get("note") ?? undefined,
  });

  const where = and(
    eq(schema.approvals.id, approvalId),
    eq(schema.approvals.organisationId, session.organisationId),
    eq(schema.approvals.status, "pending"),
  );

  const [before] = await getDb().select().from(schema.approvals).where(where);
  if (!before) return;

  const [after] = await getDb()
    .update(schema.approvals)
    .set({
      status,
      decidedBy: session.userId,
      decidedAt: new Date(),
      decisionNote: note && note.length > 0 ? note : null,
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

  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function approveApproval(formData: FormData) {
  await decide(formData, "approved");
}

export async function rejectApproval(formData: FormData) {
  await decide(formData, "rejected");
}
