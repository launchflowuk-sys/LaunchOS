"use server";

import { updateIncident } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const IncidentAction = z.object({ incidentId: z.string().uuid() });

async function setStatus(incidentId: string, status: "acknowledged" | "resolved") {
  // Server Actions are reachable by direct POST: authorise inside the action,
  // and let updateIncident scope the write to the caller's organisation.
  const session = await requireAdmin();
  await updateIncident(getDb(), session.organisationId, {
    incidentId,
    status,
    actorKind: "user",
    actorId: session.userId,
  });
  revalidatePath(`/incidents/${incidentId}`);
  revalidatePath("/incidents");
}

export async function acknowledgeIncident(formData: FormData) {
  const { incidentId } = IncidentAction.parse({ incidentId: formData.get("incidentId") });
  await setStatus(incidentId, "acknowledged");
}

export async function resolveIncident(formData: FormData) {
  const { incidentId } = IncidentAction.parse({ incidentId: formData.get("incidentId") });
  await setStatus(incidentId, "resolved");
}
