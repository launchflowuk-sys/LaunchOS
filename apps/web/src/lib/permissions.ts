import {
  assertPermission,
  defaultPermissions,
  getMemberPermissions,
  type MemberPermissions,
  type PermissionKey,
  PermissionDenied,
} from "@launchos/core";
import { cache } from "react";
import { getDb } from "./db";
import { type AdminSession, requireAdmin } from "./session";

/**
 * What the signed-in member may do, resolved once per request.
 *
 * An owner is every permission by rule (`resolvePermissions` never consults
 * the column for them), so the lookup is skipped. A staff member reads their
 * row: the default set with whatever an owner has stored laid over it.
 */
export const sessionPermissions = cache(async (): Promise<MemberPermissions> => {
  // This decides what the rail renders, and the rail renders in the layout —
  // which has to stay up while a member who owes a two-factor enrolment is
  // sent to /account to do it. The gate belongs on the pages and actions
  // behind those links, and `requirePermission` below still applies it.
  const session = await requireAdmin({ allowPendingEnrolment: true });
  if (session.role === "owner") return defaultPermissions("owner");
  const row = await getMemberPermissions(getDb(), session.organisationId, { userId: session.userId });
  return row?.permissions ?? defaultPermissions("staff");
});

export type PermissionCheck = { ok: true; session: AdminSession } | { ok: false; message: string };

/**
 * The guard at the top of a server action in a gated area. A hidden nav link
 * is not a guard — Server Actions accept direct POSTs — so the action asks the
 * database, and a refusal comes back as a sentence for the toast rather than
 * as Next's error page.
 *
 * The owner always passes without a query; anyone else goes through
 * `assertPermission`, which also refuses a suspended member.
 */
export async function requirePermission(key: PermissionKey): Promise<PermissionCheck> {
  const session = await requireAdmin();
  if (session.role === "owner") return { ok: true, session };
  try {
    await assertPermission(getDb(), session.organisationId, session.userId, key);
    return { ok: true, session };
  } catch (error) {
    if (error instanceof PermissionDenied) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * The same guard for the few actions that throw rather than return a result
 * (`setAgentEnabled`, `sendTestEmail`): a `PermissionDenied` reaches the error
 * boundary with its own message.
 */
export async function requireAdminWith(key: PermissionKey): Promise<AdminSession> {
  const check = await requirePermission(key);
  if (!check.ok) throw new PermissionDenied(key, check.message);
  return check.session;
}
