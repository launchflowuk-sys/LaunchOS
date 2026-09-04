import type { Integrations } from "@launchos/integrations";
import type { AgentDefinition } from "../kernel/types.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";

export function agentRegistry(integrations: Integrations): Record<string, AgentDefinition> {
  const defs = [hostingGuardDog(integrations)];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
