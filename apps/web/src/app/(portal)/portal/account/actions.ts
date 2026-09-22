"use server";

import { PortalThemeSchema, setPortalTheme } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";

export type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Saves the client's choice of how their portal looks.
 *
 * The **session** supplies the client id, never the form. A Server Action
 * accepts a direct POST from anywhere, so a client id in the payload would let
 * one client restyle another's portal — the sort of hole that is invisible
 * because the feature still works correctly for honest callers.
 *
 * Revalidates the whole portal rather than this page: the theme is applied by
 * the shell, so every screen under it is now stale.
 */
export async function savePortalThemeAction(theme: unknown): Promise<ActionResult> {
  const session = await requireClient();

  const parsed = PortalThemeSchema.safeParse(theme);
  if (!parsed.success) {
    return { status: "error", message: "That is not one of the available looks." };
  }

  try {
    await setPortalTheme(getDb(), session.organisationId, {
      clientId: session.clientId,
      theme: parsed.data,
      actorKind: "client",
      actorId: session.userId,
    });
    revalidatePath("/portal", "layout");
    return { status: "ok" };
  } catch {
    return { status: "error", message: "Could not save that. Try again in a moment." };
  }
}
