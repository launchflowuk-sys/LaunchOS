import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";

export const SetClientUserStatusInput = z.object({
  clientUserId: z.string().uuid(),
  status: z.enum(["active", "suspended"]),
  actorId: z.string().optional(),
});
export type SetClientUserStatusInput = z.input<typeof SetClientUserStatusInput>;

/**
 * Suspend or reactivate one portal account.
 *
 * Suspension is how portal access is revoked: `getClientSession` refuses a
 * suspended row, so the next request from that user resolves to nobody. The
 * `user` row is deliberately left alone — deleting it would cascade away the
 * audit trail's actor for everything they ever did.
 */
export async function setClientUserStatus(db: Db, organisationId: string, input: SetClientUserStatusInput) {
  const v = SetClientUserStatusInput.parse(input);
  const where = and(
    eq(schema.clientUsers.id, v.clientUserId),
    eq(schema.clientUsers.organisationId, organisationId),
  );

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.clientUsers).where(where);
    if (!before) throw new Error(`client_user ${v.clientUserId} not found in organisation`);

    const [after] = await tx
      .update(schema.clientUsers)
      .set({ status: v.status, updatedAt: new Date() })
      .where(where)
      .returning();

    await recordAudit(tx, organisationId, {
      actorKind: "user",
      actorId: v.actorId,
      action: v.status === "suspended" ? "client_user.suspended" : "client_user.reactivated",
      targetType: "client_user",
      targetId: before.id,
      before,
      after,
    });
    await recordActivity(tx, organisationId, {
      clientId: before.clientId,
      actorKind: "user",
      actorId: v.actorId,
      kind: v.status === "suspended" ? "portal.user_suspended" : "portal.user_reactivated",
      title: v.status === "suspended" ? "Portal access suspended" : "Portal access restored",
      link: `/clients/${before.clientId}/portal-users`,
    });

    return after!;
  });
}
