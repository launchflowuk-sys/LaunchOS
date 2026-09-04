"use server";

import { createClientUser, setClientUserStatus } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const InviteInput = z.object({
  clientId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(["client_admin", "client_member"]).default("client_member"),
});

export type InviteState =
  | { ok: true; email: string; oneTimePassword: string }
  | { ok: false; error: string }
  | null;

/**
 * Core error text names constraints and internals, and three different causes
 * produce near-identical strings, none of which tells Shoji what to do next.
 * Map the two he can act on and log the rest.
 */
function inviteError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/already registered/i.test(raw)) {
    return "That email already has a LaunchOS login. Ask them to use it, or invite a different address.";
  }
  if (/staff accounts cannot be client users/i.test(raw)) {
    return "That address belongs to a team member. Client logins and staff logins must be kept separate.";
  }
  console.error("invitePortalUserAction failed", error);
  return "Could not create the portal user.";
}

/**
 * The one-time password is returned to the browser once and never stored in
 * plaintext, so it is deliberately not written to a revalidated cache, a
 * redirect target or the log — the caller shows it and it is gone on refresh.
 */
export async function invitePortalUserAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  // Server Actions accept direct POSTs: authorise before reading the form.
  const session = await requireAdmin();

  const parsed = InviteInput.safeParse({
    clientId: formData.get("clientId"),
    email: formData.get("email"),
    name: formData.get("name"),
    role: formData.get("role") ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: "Enter a name and a valid email address." };

  try {
    const result = await createClientUser(getDb(), session.organisationId, {
      ...parsed.data,
      actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}/portal-users`);
    return { ok: true, email: result.user.email, oneTimePassword: result.oneTimePassword };
  } catch (error) {
    return { ok: false, error: inviteError(error) };
  }
}

const StatusInput = z.object({
  clientId: z.string().uuid(),
  clientUserId: z.string().uuid(),
  status: z.enum(["active", "suspended"]),
});

/** The shape `ActionForm` renders as a toast. */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * Suspend or reactivate one portal account — the only way to take a client
 * user's access away short of deleting their `user` row, which would cascade
 * away the audit trail's actor. `getClientSession` re-reads the status on
 * every portal request, so a suspension takes effect on their next click.
 */
export async function setPortalUserStatusAction(formData: FormData): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise before reading the form.
  const session = await requireAdmin();

  const parsed = StatusInput.safeParse({
    clientId: formData.get("clientId"),
    clientUserId: formData.get("clientUserId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { status: "error", message: "That portal account could not be updated." };

  try {
    const row = await setClientUserStatus(getDb(), session.organisationId, {
      clientUserId: parsed.data.clientUserId,
      status: parsed.data.status,
      actorId: session.userId,
    });
    revalidatePath(`/clients/${parsed.data.clientId}/portal-users`);
    return { status: "ok", id: row.id };
  } catch (error) {
    // Core's message names the row id and the constraint; neither tells Shoji
    // anything he can act on, so it goes to the log rather than the toast.
    console.error("setPortalUserStatusAction failed", error);
    return { status: "error", message: "That portal account could not be updated." };
  }
}
