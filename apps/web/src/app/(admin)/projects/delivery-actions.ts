"use server";

import { DeliveryRefused } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { queueDeliverySend } from "./delivery-queue";
import type { ActionResult } from "./schemas";

/**
 * The one write the handover panel makes: asking for the report to go out.
 *
 * Gated on `requireAdmin` and nothing narrower, for the reason the rest of
 * this module already gives: a project is delivery work, the permission
 * vocabulary (`support | content | billing | settings | approvals | access`)
 * has no key for it, and inventing one that only this screen reads would be a
 * permission nobody had been granted on the day it shipped. This action sits
 * beside `deliverProjectAction`, which closes the same project, and is gated
 * exactly as that one is.
 *
 * Server Actions accept direct POSTs, so it re-authorises and re-validates
 * rather than trusting the form it came from, and every refusal comes back as
 * a sentence for the toast rather than as Next's error page.
 */

const SendHandover = z.object({ projectId: z.string().uuid() });

export async function sendHandoverAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = SendHandover.safeParse({ projectId: formData.get("projectId") });
  if (!parsed.success) return { status: "error", message: "Could not send that handover" };
  const { projectId } = parsed.data;

  try {
    const queued = await queueDeliverySend(session.organisationId, projectId, session.userId);
    if (!queued.ok) return { status: "error", message: queued.message };
  } catch (error) {
    // A core refusal is written for the person reading the screen — "Grays
    // CabLine was cancelled…" — so it goes straight to the toast.
    if (error instanceof DeliveryRefused) return { status: "error", message: error.message };
    console.error("[projects] a handover could not be queued", { error });
    return { status: "error", message: "Could not send that handover" };
  }

  revalidatePath(`/projects/${projectId}`);
  return { status: "ok", id: projectId };
}
