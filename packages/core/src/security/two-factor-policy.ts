import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/** Nobody may switch enforcement on for a team they have not enrolled in themselves. */
export class TwoFactorPolicyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoFactorPolicyRefused";
  }
}

export const SetStaffTwoFactorRequiredInput = z.object({
  required: z.boolean(),
  /** The `user.id` of the owner making the change. Never optional: this is a lock. */
  actorId: z.string().min(1),
});
export type SetStaffTwoFactorRequiredInput = z.input<typeof SetStaffTwoFactorRequiredInput>;

/** Whether owner and staff accounts on this organisation must hold a second factor. */
export async function staffTwoFactorRequired(db: Db, organisationId: string): Promise<boolean> {
  const [row] = await db
    .select({ required: schema.organisations.requireStaffTwoFactor })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId))
    .limit(1);
  return row?.required ?? false;
}

/**
 * Everyone on the team who would be shut out the moment enforcement came on:
 * active members whose `user` row has never enrolled. Used to say the number
 * out loud on the settings control rather than letting an owner discover it
 * when a member cannot get in on a Monday morning.
 */
export async function staffWithoutTwoFactor(
  db: Db,
  organisationId: string,
): Promise<readonly { userId: string; email: string; role: "owner" | "staff" }[]> {
  return db
    .select({
      userId: schema.organisationMembers.userId,
      email: schema.user.email,
      role: schema.organisationMembers.role,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.status, "active"),
        ne(schema.user.twoFactorEnabled, true),
      ),
    )
    .orderBy(schema.organisationMembers.createdAt);
}

/**
 * Switches the staff two-factor requirement on or off, and audits it.
 *
 * Switching it **on** is refused unless the owner doing it has already
 * enrolled. This is the whole lock-out guard: enforcement is read by
 * `requireAdmin` on every admin request, so an owner who turned it on from an
 * unenrolled account would bounce themselves — and every member — to a screen
 * they can still reach but with no way back, on a live system. Enrolling
 * first costs thirty seconds and makes the switch reversible: the same owner
 * can always turn it off again from `/account`, with their password.
 *
 * Switching it **off** carries no such condition. A safety valve that needs
 * the thing it protects against is not a safety valve.
 */
export async function setStaffTwoFactorRequired(
  db: Db,
  organisationId: string,
  input: SetStaffTwoFactorRequiredInput,
) {
  const v = SetStaffTwoFactorRequiredInput.parse(input);

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const where = eq(schema.organisations.id, organisationId);

    const [before] = await tx
      .select({ required: schema.organisations.requireStaffTwoFactor })
      .from(schema.organisations)
      .where(where);
    if (!before) throw new Error(`organisation ${organisationId} not found`);

    if (v.required) {
      const [actor] = await tx
        .select({ enrolled: schema.user.twoFactorEnabled })
        .from(schema.user)
        .where(eq(schema.user.id, v.actorId))
        .limit(1);
      if (!actor?.enrolled) {
        throw new TwoFactorPolicyRefused(
          "Set up two-factor on your own account before requiring it for the team — otherwise this would lock you out.",
        );
      }
    }

    const [after] = await tx
      .update(schema.organisations)
      .set({ requireStaffTwoFactor: v.required, updatedAt: new Date() })
      .where(where)
      .returning({ required: schema.organisations.requireStaffTwoFactor });

    await recordAudit(tx, organisationId, {
      actorKind: "user",
      actorId: v.actorId,
      action: "organisation.two_factor_policy_updated",
      targetType: "organisation",
      targetId: organisationId,
      before,
      after,
    });

    return after!.required;
  });
}
