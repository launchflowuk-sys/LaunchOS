"use server";

import { createClientUser } from "@launchos/core";
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
    const result = await createClientUser(getDb(), session.organisationId, parsed.data);
    revalidatePath(`/clients/${parsed.data.clientId}/portal-users`);
    return { ok: true, email: result.user.email, oneTimePassword: result.oneTimePassword };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not create the portal user." };
  }
}
