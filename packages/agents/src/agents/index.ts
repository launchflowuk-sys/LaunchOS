import type { AgentIntegrations } from "./integrations.js";
import type { AgentDefinition } from "../kernel/types.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";
import { supportTriage } from "./support-triage/index.js";

export function agentRegistry(integrations: AgentIntegrations): Record<string, AgentDefinition> {
  const defs = [hostingGuardDog(integrations), supportTriage(integrations)];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
