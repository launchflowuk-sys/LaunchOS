"use server";

import { removeDemoClients, seedDemoClients, seedPortalShowcase } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

export type ActionResult = { status: "ok"; message: string } | { status: "error"; message: string };

/**
 * Demo data, from the admin rather than a terminal.
 *
 * The CLI (`pnpm demo:seed`) needs a `DATABASE_URL` for whichever database you
 * mean, which is fine on a laptop and wrong for production — it means holding
 * the production credential to press a button. This runs it in the app, as the
 * signed-in owner, against the database the app is already connected to.
 *
 * Both sides are behind `settings`, the permission an owner holds and an
 * operations hire does not: this writes and deletes whole clients.
 */

/** Everything the CLI writes: the three sales records and the six-month portal client. */
export async function seedDemoDataAction(): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };

  try {
    const db = getDb();
    // Removed first, exactly as the CLI does: seeding over an existing demo
    // collides on the slug, and a half-written second copy is worse than none.
    await removeDemoClients(db, gate.session.organisationId);
    await seedDemoClients(db, gate.session.organisationId);
    const portal = await seedPortalShowcase(db, gate.session.organisationId);

    const rows = Object.values(portal.created).reduce((sum, n) => sum + n, 0);
    revalidatePath("/settings/demo-data");
    revalidatePath("/clients");
    return {
      status: "ok",
      message: `Demo data written — four clients, including six months of history (${rows} records).`,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not write the demo data.",
    };
  }
}

/** Takes every demo record away. Everything hangs off the clients, so this is complete. */
export async function removeDemoDataAction(): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };

  try {
    const { removed } = await removeDemoClients(getDb(), gate.session.organisationId);
    revalidatePath("/settings/demo-data");
    revalidatePath("/clients");
    return {
      status: "ok",
      message:
        removed === 0
          ? "There was no demo data to remove."
          : `Removed ${removed} demo client${removed === 1 ? "" : "s"} and everything hanging off them.`,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not remove the demo data.",
    };
  }
}
