"use server";

import { setClientService } from "@launchos/core";
import { schema } from "@launchos/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const ToggleSchema = z.object({
  clientId: z.string().uuid(),
  service: z.enum(schema.clientServiceEnum.enumValues),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});

/**
 * Switches one service on or off for one client.
 *
 * Behind the billing permission: deciding what we do for a client is a
 * commercial decision, the same kind as the package they are on, and the owner
 * always passes. Core asserts the client belongs to the organisation, so a
 * posted id from somewhere else is refused there rather than trusted here.
 */
export async function setClientServiceAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const parsed = ToggleSchema.safeParse({
    clientId: formData.get("clientId"),
    service: formData.get("service"),
    active: formData.get("active"),
  });
  if (!parsed.success) return { status: "error", message: "That switch could not be read. Reload the page and try again." };
  const { clientId, service, active } = parsed.data;

  try {
    await setClientService(getDb(), gate.session.organisationId, {
      clientId, service, active, actorKind: "user", actorId: gate.session.userId,
    });
  } catch (error) {
    console.error("Could not change the client service", error);
    return { status: "error", message: "The service could not be changed. Nothing was switched." };
  }

  revalidatePath(`/clients/${clientId}/services`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  return { status: "ok" };
}
