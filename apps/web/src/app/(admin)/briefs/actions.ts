"use server";

import { QUEUE } from "@launchos/core/queue";
import { sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * "Write today's brief": hands the organisation to the `ops.brief` job the
 * worker runs at 07:00 anyway. The key carries a timestamp on purpose — the
 * cron send is deduped per day, and a person pressing this wants a run now,
 * not to be swallowed as a duplicate of this morning's. A run the same day
 * replaces the brief and tells the owner again.
 */
export async function writeBriefAction(): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise first, and queue for the
  // caller's organisation only.
  const session = await requireAdmin();
  try {
    await sendJob(
      QUEUE.opsBrief,
      { organisationId: session.organisationId, trigger: "manual" },
      { singletonKey: `ops-brief:${session.organisationId}:manual:${Date.now()}` },
    );
    return { status: "ok" };
  } catch (error) {
    console.error("ops.brief could not be queued from the Briefs screen", error);
    return { status: "error", message: "The brief could not be queued. Is the worker's queue reachable?" };
  }
}
