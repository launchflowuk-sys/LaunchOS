import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListApprovalsInput = z.object({
  status: z.enum(schema.approvalStatusEnum.enumValues).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListApprovalsInput = z.input<typeof ListApprovalsInput>;

export interface ApprovalListRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  /** Which agent asked, when an agent did. Null for anything raised by a person or the portal. */
  readonly agentKey: string | null;
  /** How long it has been waiting, in whole hours. Null once decided. */
  readonly pendingHours: number | null;
}

/**
 * The approvals queue, for a caller outside the admin.
 *
 * **`payload` is not returned, and that is the point.** It carries the actual
 * outward action — the message body about to be sent to a client, the DNS
 * record, the invoice — and every one of those is content this endpoint has no
 * business handing to an assistant that might repeat it. What a reader needs to
 * know is *that a decision is waiting, what kind, and how long it has waited*;
 * deciding it is a human act performed in the admin, where the full payload is
 * shown to the person taking responsibility for it.
 *
 * Ordered by `created_at` with an id tiebreak, so an offset page never repeats
 * or skips a row when two approvals share a timestamp — the same reason the
 * admin's decided list does it.
 */
export async function listApprovals(
  db: Db,
  organisationId: string,
  input: ListApprovalsInput = {},
  now: Date = new Date(),
): Promise<{ approvals: ApprovalListRow[]; total: number }> {
  const v = ListApprovalsInput.parse(input);
  const where = and(
    eq(schema.approvals.organisationId, organisationId),
    v.status ? eq(schema.approvals.status, v.status) : undefined,
  );

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: schema.approvals.id,
        kind: schema.approvals.kind,
        title: schema.approvals.title,
        status: schema.approvals.status,
        createdAt: schema.approvals.createdAt,
        decidedAt: schema.approvals.decidedAt,
        decisionNote: schema.approvals.decisionNote,
        agentKey: schema.agentRuns.agentKey,
      })
      .from(schema.approvals)
      .leftJoin(schema.agentRuns, eq(schema.approvals.runId, schema.agentRuns.id))
      .where(where)
      .orderBy(desc(schema.approvals.createdAt), desc(schema.approvals.id))
      .limit(v.limit)
      .offset(v.offset),
    db.select({ value: count() }).from(schema.approvals).where(where),
  ]);

  return {
    approvals: rows.map((row) => ({
      ...row,
      pendingHours:
        row.status === "pending"
          ? Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000))
          : null,
    })),
    total: total?.value ?? 0,
  };
}
