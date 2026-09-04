import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { countActiveOwners } from "./list-members.js";

export const DeactivateMemberInput = z.object({ memberId: z.string().uuid(), actorId: z.string().optional() });
export type DeactivateMemberInput = z.input<typeof DeactivateMemberInput>;

/**
 * Suspends rather than deletes: `getSession` only accepts active memberships,
 * so a suspended member is signed out on their next request while their audit
 * trail stays attributable.
 */
export async function deactivateMember(db: Db, organisationId: string, input: DeactivateMemberInput) {
  const v = DeactivateMemberInput.parse(input);
  const where = and(
    eq(schema.organisationMembers.id, v.memberId),
    eq(schema.organisationMembers.organisationId, organisationId),
  );

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.organisationMembers).where(where);
    if (!before) throw new Error(`organisation_member ${v.memberId} not found in organisation`);
    if (before.role === "owner" && before.status === "active" && (await countActiveOwners(inner, organisationId)) <= 1) {
      throw new Error("cannot deactivate the last active owner");
    }
    const [after] = await tx
      .update(schema.organisationMembers)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(where)
      .returning();
    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "member.deactivated",
      targetType: "organisation_member", targetId: v.memberId, before, after,
    });
    return after!;
  });
}
