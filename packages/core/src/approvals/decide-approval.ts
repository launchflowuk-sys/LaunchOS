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
 * `status = 'pending' AND decided_at IS NULL` under the row lock, so of any
 * number of concurrent decisions on the same approval exactly one gets a row
 * back and every other caller sees `alreadyDecided`. A SELECT-then-UPDATE would
 * leave a window in which both callers read `pending` and both went on to act.
 *
 * **This function is the only writer of the decision fields.** `status`,
 * `decided_by`, `decided_at` and `decision_note` are all stamped here, in one
 * statement, for a run-backed approval exactly as for a human-raised one. The
 * agent kernel never writes them: `resumeAgent` *reads* this row to learn who
 * decided, what they decided and why, so the approver on the card, the approver
 * in `audit_log` and the approver in the database can never disagree, and a
 * resume that dies can never leave a row decided-but-`pending` with no way to
 * re-drive it.
 *
 * What tells the kernel a decision has not been carried out yet is therefore
 * *not* the approval status but `agent_runs.metadata.pending` — the parked loop
 * state, which `runLoop` clears the moment the run finishes or re-parks.
 *
 * **A decision is final once this function commits.** Nothing releases it, and
 * there is deliberately no inverse: the follow-on work (enqueueing
 * `agent.resume`) is *delivery*, and delivery failing is not evidence the
 * decision did not happen. `boss.send` is a single INSERT whose promise can
 * reject after the row committed, so an "undo" driven by that rejection would
 * revert decisions that had already been carried out — with the outward action
 * already sent. Durability of the delivery belongs to the `approvals.resume-sweep`
 * cron instead (`apps/worker/src/jobs/resume-sweep.ts`), which re-enqueues any
 * decided approval whose run is still parked.
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
      status: v.decision,
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
