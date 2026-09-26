"use server";

import { redeployApp, runServerAction, setServerBusiness, type ServerCommand } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

/**
 * Every action on this screen touches a real Hetzner server or a real
 * Coolify deploy, so it is owner-only regardless of the `settings`
 * permission that merely shows the nav entry — same split as
 * `settings/infrastructure/actions.ts`.
 */
async function requireOwner() {
  const session = await requireAdmin();
  if (session.role !== "owner") throw new Error("Only the owner can act on servers.");
  return session;
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function serverAction(serverId: string, command: ServerCommand, confirmName?: string): Promise<ActionResult> {
  const session = await requireOwner();
  try {
    await runServerAction(getDb(), session.organisationId, { serverId, command, confirmName, actorId: session.userId });
    revalidatePath("/servers");
    return { ok: true, message: "Sent to Hetzner." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed." };
  }
}

export async function businessAction(serverId: string, business: string): Promise<ActionResult> {
  const session = await requireOwner();
  try {
    await setServerBusiness(getDb(), session.organisationId, { serverId, business: business as never, actorId: session.userId });
    revalidatePath("/servers");
    revalidatePath("/profit");
    return { ok: true, message: "Saved." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed." };
  }
}

export async function redeployAction(connectionId: string, appUuid: string, appName: string): Promise<ActionResult> {
  const session = await requireOwner();
  try {
    await redeployApp(getDb(), session.organisationId, { connectionId, appUuid, appName, actorId: session.userId });
    return { ok: true, message: `Redeploy of ${appName} started.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed." };
  }
}
