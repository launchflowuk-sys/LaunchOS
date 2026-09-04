"use server";

import { markInitialPasswordSet } from "@launchos/core";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export type ChangePasswordState = { status: "idle" } | { status: "changed" } | { status: "error"; message: string };

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
 * On success it stamps `organisation_members.initial_password_set_at`. That is
 * what closes the re-issue window on `/team`: until a member replaces the
 * password an owner issued them, an owner may mint another one over the top of
 * it, and from this moment they may not. The stamp is deliberately after the
 * change and never before — a stamp without a changed password would strand a
 * member on a credential nobody can replace.
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
    // The point of a password change: if the old one leaked, every session it
    // opened goes with it. Deliberately the separate `revokeOtherSessions`
    // endpoint rather than the flag on `changePassword` — the flag deletes
    // *every* session including this one and mints a replacement, which only
    // reaches the browser if something copies the `set-cookie` Better Auth
    // built onto Next's own cookie store. In a server action nothing does, so
    // the member would be signed out by the act of changing their password and
    // the re-render that follows the action would bounce them to /sign-in.
    // This endpoint keeps the caller's session and deletes the rest.
    await getAuth().api.revokeOtherSessions({ headers: requestHeaders });
  } catch (error) {
    // Better Auth reports a wrong current password and a too-short new one as
    // APIError; its message is safe to show, and says which of the two it was.
    if (error instanceof APIError) {
      return { status: "error", message: error.message || "That password could not be changed." };
    }
    throw error;
  }

  await markInitialPasswordSet(getDb(), session.organisationId, { userId: session.userId });

  // /team renders the re-issue control off that column.
  revalidatePath("/team");
  revalidatePath("/account");
  return { status: "changed" };
}
