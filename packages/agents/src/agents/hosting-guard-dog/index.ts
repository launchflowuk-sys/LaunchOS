import type { AgentIntegrations } from "../integrations.js";
import type { AgentDefinition } from "../../kernel/types.js";
import { uptimeCheckSite } from "../../tools/uptime-check-site.js";
import { hostingGetResources } from "../../tools/hosting-get-resources.js";
import { incidentsUpdate } from "../../tools/incidents-update.js";
import { ticketsCreate } from "../../tools/tickets-create.js";

export const HOSTING_GUARD_DOG_PROMPT = `You are the Hosting Guard-Dog for a UK web agency. An incident has been opened because a monitored site failed its uptime check three times in a row.

Your job, in order:
1. Confirm the outage: call uptime_check_site with the siteId from the payload.
2. Inspect hosting with hosting_get_resources using the hostingRef.
3. Create one internal ticket with tickets_create: subject states the site and the most likely cause; body is a short Markdown diagnosis with the evidence you gathered; severity "critical" if the site is fully down, "high" if degraded.
4. Update the incident with incidents_update: status "acknowledged" and a Markdown summary (Diagnosis, Evidence, Recommended next step).
Finish with one sentence describing what you did. Do not invent evidence. If the site responds OK on your check, say so, set severity "medium", and still acknowledge the incident.`;

export function hostingGuardDog(integrations: AgentIntegrations): AgentDefinition {
  return {
    key: "hosting-guard-dog",
    name: "Hosting Guard-Dog",
    description: "Diagnoses site outages, opens an internal ticket and acknowledges the incident.",
    trigger: { kind: "event", event: "incident.opened" },
    systemPrompt: HOSTING_GUARD_DOG_PROMPT,
    tools: [uptimeCheckSite(integrations.uptime), hostingGetResources(integrations.hosting), ticketsCreate, incidentsUpdate],
    maxTurns: 8,
  };
}
