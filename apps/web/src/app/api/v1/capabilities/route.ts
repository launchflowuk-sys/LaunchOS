import { listAgentEnablement } from "@launchos/core";
import { getDb } from "@/lib/db";
import { agentCatalog } from "@/lib/agent-catalog";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { buildCapabilities } from "@/lib/api/capabilities";
import { apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * Everything LaunchOS can do, generated from the registry the worker runs.
 *
 * This is the answer to "what can you actually do?", and the point of generating
 * it is that the answer stays true — a tool registered next year appears here
 * the day it lands, without anyone remembering to update a list.
 *
 * It is also the list supervised autonomy will be a selection *from* (spec point
 * 9), which is why every tool carries its `delegability` and not only its risk:
 * the picker needs to know what may be handed over before it offers anything.
 *
 * Gated on `settings`, matching the admin's own Agents screen. It describes the
 * system rather than any client's data, but what it describes is the shape of
 * what can be automated, and that belongs with the permission governing
 * automation.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "settings")) return forbidden("settings");

  const generatedAt = new Date();
  const enablement = await listAgentEnablement(getDb(), auth.caller.organisationId);
  const { capabilities, summary } = buildCapabilities(agentCatalog(), enablement);

  return apiOk({ capabilities, summary }, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
