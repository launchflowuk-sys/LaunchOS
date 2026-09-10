"use server";

import { advanceSiteBuild } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

export type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * The gate. Everything before this is machinery; this is the decision.
 *
 * Approving does not itself tell the client — it records that the site may be
 * shown. Telling them is a separate stage, so that "I have looked at this and
 * it is good" and "the client now has it" stay two different acts with two
 * different timestamps and two different people responsible.
 */
export async function approveSiteBuildAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  try {
    await advanceSiteBuild(
      getDb(),
      gate.session.organisationId,
      String(formData.get("buildId") ?? ""),
      "approved",
      {},
      gate.session.userId,
    );
    revalidatePath("/site-builds");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}

/**
 * Stops a build.
 *
 * The website it created is left standing on purpose. The row keeps
 * `hosting_username`, which is what `abandonedWithHosting` reads, so the site
 * shows up on the orphan list rather than vanishing from the record while
 * quietly still existing on the host. Deleting real hosting is not something a
 * single button press should do.
 */
export async function cancelSiteBuildAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  try {
    await advanceSiteBuild(
      getDb(),
      gate.session.organisationId,
      String(formData.get("buildId") ?? ""),
      "cancelled",
      {},
      gate.session.userId,
    );
    revalidatePath("/site-builds");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}
