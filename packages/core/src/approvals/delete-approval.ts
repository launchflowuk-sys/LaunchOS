import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * Clearing rejected approvals off the queue.
 *
 * Rejected cards had nowhere to go. They stayed on `/approvals` for ever, and a
 * queue that never empties stops being read — which matters more than tidiness,
 * because the same queue is where an agent asks to send a client an email.
 *
 * **Only rejected cards can be deleted.** A pending card is still waiting on a
 * person, and an approved one is the record of what an agent was allowed to do
 * — the audit trail of a decision that had an effect in the world. Neither is
 * noise, and neither is removable here. That is the guard, and it is enforced
 * in the query rather than in the caller, so a wrong id or another
 * organisation's id deletes nothing at all rather than something unexpected.
 */

export const DeleteApprovalInput = z.object({
  approvalId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type DeleteApprovalInput = z.input<typeof DeleteApprovalInput>;

export class ApprovalNotDeletable extends Error {
  constructor(readonly status: string) {
    super(
      status === "pending"
        ? "That approval is still waiting on a decision. Reject it first if you do not want it."
        : "An approved card is the record of what an agent was allowed to do, and is kept.",
    );
    this.name = "ApprovalNotDeletable";
  }
}

/** One rejected card. Throws rather than silently doing nothing, so the screen can say why. */
export async function deleteApproval(db: Db, organisationId: string, input: DeleteApprovalInput): Promise<void> {
  const v = DeleteApprovalInput.parse(input);

  const [before] = await db
    .select({ id: schema.approvals.id, status: schema.approvals.status, kind: schema.approvals.kind, title: schema.approvals.title })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!before) throw new Error("that approval could not be found");
  if (before.status !== "rejected") throw new ApprovalNotDeletable(before.status);

  await db
    .delete(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));

  // Audited before it is gone is not possible, so audited after, from what was
  // read. The card no longer exists; the fact that it was cleared does.
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.actorId,
    action: "approval.deleted",
    targetType: "approval",
    targetId: v.approvalId,
    before: { status: before.status, kind: before.kind, title: before.title },
  });
}

/**
 * Every rejected card at once.
 *
 * One audit row for the sweep rather than one per card: what happened is "the
 * rejected pile was cleared", and a hundred rows saying the same thing buries
 * the entries that describe something a person actually decided.
 */
export async function deleteRejectedApprovals(
  db: Db,
  organisationId: string,
  actorId: string,
): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(schema.approvals)
    .where(and(eq(schema.approvals.organisationId, organisationId), eq(schema.approvals.status, "rejected")))
    .returning({ id: schema.approvals.id });

  if (deleted.length === 0) return { deleted: 0 };

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId,
    action: "approval.rejected_cleared",
    targetType: "approval",
    // The sweep has no single target. The organisation is the thing it happened
    // to, and `before` carries what it actually cleared.
    targetId: organisationId,
    before: { count: deleted.length, ids: deleted.map((row) => row.id) },
  });

  return { deleted: deleted.length };
}
