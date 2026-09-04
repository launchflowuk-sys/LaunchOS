import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const RecordOwnPasswordChangeInput = z.object({ userId: z.string().min(1) });
export type RecordOwnPasswordChangeInput = z.input<typeof RecordOwnPasswordChangeInput>;

export type RecordOwnPasswordChangeResult = {
  /** The membership row as it stands after the change. */
  member: typeof schema.organisationMembers.$inferSelect;
  /** True only on the change that took the member off the issued credential. */
  stamped: boolean;
};

/**
 * Records that a member has changed their own password.
 *
 * Two things happen here and they are deliberately not the same thing:
 *
 *  1. **Every** change is audited as `member.password_changed`. "Somebody
 *     replaced this account's password" is the single event most worth
 *     reconstructing after an account takeover, and the equivalent done *to* a
 *     member by an owner on `/team` is already audited (`member.password_reissued`).
 *     Auditing only the first change would leave every later one — which after
 *     the account screen shipped is the normal case — with no row at all.
 *  2. The **first** change also stamps `organisation_members.initial_password_set_at`
 *     and audits `member.initial_password_set`. That column is the whole reason
 *     `/team` stops offering "Re-issue password": while it is NULL the member is
 *     still on an admin-issued credential and there is nothing personal to
 *     overwrite, so an owner may mint a new one. Once it is stamped the
 *     credential belongs to the member and `reissueOneTimePassword` refuses.
 *     The stamp records when that transition happened, so it is written once and
 *     never moved forward by a later change.
 *
 * Neither the password nor its hash is ever passed in or recorded — the same
 * discipline `reissue-password.ts` keeps. The audit's `before`/`after` are the
 * membership rows, which carry no credential.
 *
 * Keyed on `userId`, not `memberId`, because the caller is the member
 * themselves: the account screen has a session, not a row id. Scoped by
 * `organisationId` like every other service, so a user who is a member of two
 * organisations only has the membership they are signed in to touched.
 *
 * The membership row is locked `FOR UPDATE` before it is read. Two concurrent
 * changes (a double-submitted form) would otherwise both see a NULL stamp; the
 * second would then write an `member.initial_password_set` row for a stamp it
 * did not make.
 *
 * Returns `null` for a user with no membership in this organisation rather than
 * throwing: the password change this follows has already committed, and failing
 * here would tell the member otherwise.
 */
export async function recordOwnPasswordChange(
  db: Db,
  organisationId: string,
  input: RecordOwnPasswordChangeInput,
): Promise<RecordOwnPasswordChangeResult | null> {
  const v = RecordOwnPasswordChangeInput.parse(input);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.organisationId, organisationId),
          eq(schema.organisationMembers.userId, v.userId),
        ),
      )
      .for("update");
    if (!before) return null;

    const stamped = before.initialPasswordSetAt === null;
    let after = before;
    if (stamped) {
      const now = new Date();
      const [row] = await tx
        .update(schema.organisationMembers)
        .set({ initialPasswordSetAt: now, updatedAt: now })
        .where(eq(schema.organisationMembers.id, before.id))
        .returning();
      // The row is locked above, so the update cannot lose it; `?? before`
      // keeps the audit's `after` a row rather than `undefined` regardless.
      after = row ?? before;
    }

    const audited = {
      actorKind: "user",
      actorId: v.userId,
      targetType: "organisation_member",
      targetId: before.id,
      before,
      after,
    } as const;

    await recordAudit(tx as unknown as Db, organisationId, { ...audited, action: "member.password_changed" });
    if (stamped) {
      await recordAudit(tx as unknown as Db, organisationId, { ...audited, action: "member.initial_password_set" });
    }

    return { member: after, stamped };
  });
}
