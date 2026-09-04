"use server";

import { recordOwnPasswordChange } from "@launchos/core";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export type ChangePasswordState =
  | { status: "idle" }
  /**
   * The password *has* been replaced. `warning` carries anything that failed
   * afterwards and could not undo it — see `revokeOtherSessions` below.
   */
  | { status: "changed"; warning?: string }
  | { status: "error"; message: string };

/** Shown when the change committed but the other sessions outlived it. */
const REVOKE_FAILED =
  "Your password was changed, but your other sessions could not be signed out — sign out on your other devices manually.";

/**
 * Shown when the change committed but `audit_log` did not record it.
 *
 * An unaudited password change is an integrity failure, so it must be said out
 * loud — but not by reporting the change as failed. See the note on the action.
 */
const AUDIT_FAILED =
  "Your password was changed, but the change could not be recorded in the audit log — tell the owner so it can be checked.";

/**
 * Deliberately no `min` on `newPassword`. The floor is `minPasswordLength` in
 * `lib/auth.ts`, Better Auth enforces it inside `changePassword`, and it is the
 * only place that also covers the portal form and a raw POST to `/api/auth`.
 * Repeating the number here would be a second copy to drift.
 */
const Input = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(1, "Enter a new password."),
});

/**
 * A staff member changes their own password.
 *
 * Everything here is about the signed-in user: the session names them, and
 * nothing in the form says who is being changed. An owner who wants to replace
 * somebody *else's* password uses `/team`, which is audited as a re-issue and
 * hands over a one-time password.
 *
 * On success it calls `recordOwnPasswordChange`, which audits the change and,
 * the first time, stamps `organisation_members.initial_password_set_at`. That
 * stamp is what closes the re-issue window on `/team`: until a member replaces
 * the password an owner issued them, an owner may mint another one over the top
 * of it, and from this moment they may not. Both are deliberately after the
 * change and never before — a stamp without a changed password would strand a
 * member on a credential nobody can replace.
 *
 * Everything after `changePassword` returns is post-commit: the new credential
 * is already in the database and nothing here can put the old one back. So
 * nothing after that point may report the change as failed — **including the
 * audit write.** A password change no `audit_log` row records is an integrity
 * failure and must not be swallowed, but letting it throw out of the action was
 * a *false negative*: a transient database error showed the member a generic
 * failure, and their next attempt used a current password that no longer works.
 * Both warnings say what happened instead, the failure is logged with the
 * organisation and user on it, and the audit gap is still visible in
 * `audit_log` by its absence — which is what an integrity review looks for.
 */
export async function changeOwnPasswordAction(
  _previous: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await requireAdmin();

  const parsed = Input.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form." };

  const requestHeaders = await headers();

  try {
    await getAuth().api.changePassword({
      body: { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword },
      headers: requestHeaders,
    });
  } catch (error) {
    // Better Auth reports a wrong current password and a too-short new one as
    // APIError; its message is safe to show, and says which of the two it was.
    // Nothing has been written at this point, so this is the only place the
    // action may say the change did not happen.
    if (error instanceof APIError) {
      return { status: "error", message: error.message || "That password could not be changed." };
    }
    throw error;
  }

  // ---- Past this line the new credential is committed. ----

  // Every failure past this line is a warning on a successful change, never a
  // failure; more than one can happen, so they are collected rather than
  // overwritten.
  const warnings: string[] = [];

  try {
    await recordOwnPasswordChange(getDb(), session.organisationId, { userId: session.userId });
  } catch (error) {
    // This also skips `initial_password_set_at`, so an owner may still re-issue
    // over the top of a password the member has in fact replaced. Saying so is
    // the point of the warning: the member can ask for it to be checked.
    console.error("[account] password changed but the audit write failed", {
      organisationId: session.organisationId,
      userId: session.userId,
      error,
    });
    warnings.push(AUDIT_FAILED);
  }

  // The point of a password change: if the old one leaked, every session it
  // opened goes with it. Deliberately the separate `revokeOtherSessions`
  // endpoint rather than the flag on `changePassword` — the flag deletes
  // *every* session including this one and mints a replacement, which only
  // reaches the browser if something copies the `set-cookie` Better Auth built
  // onto Next's own cookie store. In a server action nothing does, so the
  // member would be signed out by the act of changing their password and the
  // re-render that follows the action would bounce them to /sign-in. This
  // endpoint keeps the caller's session and deletes the rest.
  //
  // A failure here is reported as a warning on a successful change, never as a
  // failure: the password has already been replaced, and telling the member
  // otherwise sends them back to a current password that no longer works.
  try {
    await getAuth().api.revokeOtherSessions({ headers: requestHeaders });
  } catch (error) {
    console.error("[account] password changed but revokeOtherSessions failed", {
      organisationId: session.organisationId,
      userId: session.userId,
      error,
    });
    warnings.push(REVOKE_FAILED);
  }

  // /team renders the re-issue control off `initial_password_set_at`.
  revalidatePath("/team");
  revalidatePath("/account");
  // `exactOptionalPropertyTypes`: an absent warning is an absent key, not an
  // explicit `undefined`.
  const warning = warnings.join(" ");
  return warning ? { status: "changed", warning } : { status: "changed" };
}
