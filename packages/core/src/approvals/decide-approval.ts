import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

export const DecideApprovalInput = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  decidedByUserId: z.string().min(1),
  note: z.string().trim().max(1000).optional(),
});
export type DecideApprovalInput = z.input<typeof DecideApprovalInput>;

export type ApprovalRow = typeof schema.approvals.$inferSelect;

/**
 * `alreadyDecided` means someone else's click won the race (or the same person
 * clicked twice). The caller must then enqueue nothing and send nothing — it is
 * the only signal that stops approve-then-reject queueing two resume jobs, or
 * two approvals of an invoice send emailing the client twice.
 */
export type DecideApprovalResult =
  | { alreadyDecided: true; approval: ApprovalRow | undefined }
  | { alreadyDecided: false; before: ApprovalRow; after: ApprovalRow };

/**
 * Claims a pending approval for exactly one decision.
 *
 * The claim is the single conditional UPDATE below: Postgres resolves
 * `decided_at IS NULL` under the row lock, so of any number of concurrent
 * decisions on the same approval exactly one gets a row back and every other
 * caller sees `alreadyDecided`. A SELECT-then-UPDATE would leave a window in
 * which both callers read `pending` and both went on to act.
 *
 * `decided_at`, not `status`, is the claim marker, because an approval that
 * belongs to an agent run must stay `pending` until the kernel resumes it:
 * `resumeAgent` refuses an approval that is already decided, so pre-stamping
 * `status` here would strand the run. For an approval with no run behind it (a
 * human-raised invoice send) there is nothing to resume, so the status is
 * stamped in the same statement and the decision is final immediately.
 *
 * Audit is left to the caller: the admin portal distinguishes a decision that
 * was queued for an agent from one that took effect on the spot.
 */
export async function decideApproval(
  db: Db,
  organisationId: string,
  input: DecideApprovalInput,
  now: Date = new Date(),
): Promise<DecideApprovalResult> {
  const v = DecideApprovalInput.parse(input);

  const [before] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!before) return { alreadyDecided: true, approval: undefined };

  const [after] = await db
    .update(schema.approvals)
    .set({
      // An agent-backed approval keeps `pending` so the kernel can resume it.
      ...(before.runId ? {} : { status: v.decision }),
      decidedBy: v.decidedByUserId,
      decidedAt: now,
      decisionNote: v.note ?? null,
      updatedAt: now,
    })
    .where(and(
      eq(schema.approvals.id, v.approvalId),
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.decidedAt),
    ))
    .returning();

  if (!after) return { alreadyDecided: true, approval: before };
  return { alreadyDecided: false, before, after };
}
