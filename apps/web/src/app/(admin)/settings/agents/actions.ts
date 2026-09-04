"use server";

import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { agentCatalog } from "@/lib/agent-catalog";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const ToggleInput = z.object({
  agentKey: z.string().min(1),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setAgentEnabled(formData: FormData) {
  // Server Actions accept direct POSTs: authorise, then only accept agent keys
  // this build actually knows about.
  const session = await requireAdmin();
  const { agentKey, enabled } = ToggleInput.parse({
    agentKey: formData.get("agentKey"),
    enabled: formData.get("enabled"),
  });
  if (!agentCatalog().some((a) => a.key === agentKey)) throw new Error(`unknown agent ${agentKey}`);

  const [before] = await getDb()
    .select()
    .from(schema.agentEnablement)
    .where(
      and(
        eq(schema.agentEnablement.organisationId, session.organisationId),
        eq(schema.agentEnablement.agentKey, agentKey),
      ),
    );

  const [after] = await getDb()
    .insert(schema.agentEnablement)
    .values({ organisationId: session.organisationId, agentKey, enabled })
    .onConflictDoUpdate({
      target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey],
      set: { enabled, updatedAt: new Date() },
    })
    .returning();

  await recordAudit(getDb(), session.organisationId, {
    actorKind: "user",
    actorId: session.userId,
    action: enabled ? "agent.enabled" : "agent.disabled",
    targetType: "agent_enablement",
    targetId: after?.id ?? agentKey,
    before: before ?? null,
    after,
  });

  revalidatePath("/settings/agents");
}
