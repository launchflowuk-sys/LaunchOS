import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const MarkInitialPasswordSetInput = z.object({ userId: z.string().min(1) });
export type MarkInitialPasswordSetInput = z.input<typeof MarkInitialPasswordSetInput>;

/**
 * Records that a member has replaced the password an owner issued them with
 * one of their own, by stamping `organisation_members.initial_password_set_at`.
 *
 * That column is the whole reason `/team` stops offering "Re-issue password":
 * while it is NULL the member is still on an admin-issued credential and there
 * is nothing personal to overwrite, so an owner may mint a new one. Once it is
 * stamped the credential belongs to the member, and `reissueOneTimePassword`
 * refuses. Nothing stamped it before this — the column could only ever be NULL,
 * which made the guard on the other side of it permanently open.
 *
 * Keyed on `userId`, not `memberId`, because the caller is the member
 * themselves: the account screen has a session, not a row id. Scoped by
 * `organisationId` like every other service, so a user who is a member of two
 * organisations only has the membership they are signed in to stamped.
 *
 * Idempotent by design: `initial_password_set_at IS NULL` is part of the WHERE,
 * so the second password change of the day does not overwrite the first
 * stamp — the column records when the member stopped using the issued
 * password, and that moment happened once. A no-op returns `null` and audits
 * nothing rather than throwing: the password change it follows has already
 * succeeded, and failing here would tell the member otherwise.
 */
export async function markInitialPasswordSet(db: Db, organisationId: string, input: MarkInitialPasswordSetInput) {
  const v = MarkInitialPasswordSetInput.parse(input);

  return db.transaction(async (tx) => {
    const where = and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.userId, v.userId),
      isNull(schema.organisationMembers.initialPasswordSetAt),
    );

    const [before] = await tx.select().from(schema.organisationMembers).where(where);
    if (!before) return null;

    const [after] = await tx
      .update(schema.organisationMembers)
      .set({ initialPasswordSetAt: new Date(), updatedAt: new Date() })
      .where(where)
      .returning();

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user",
      actorId: v.userId,
      action: "member.initial_password_set",
      targetType: "organisation_member",
      targetId: before.id,
      before,
      after,
    });

    return after ?? null;
  });
}
