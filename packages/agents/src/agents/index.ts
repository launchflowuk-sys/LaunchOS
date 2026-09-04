import type { EmailAdapter } from "@launchos/channels";
import type { AgentIntegrations } from "./integrations.js";
import type { AgentDefinition } from "../kernel/types.js";
import { adPerformanceSentinel } from "./ad-performance-sentinel/index.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";
import { supportTriage } from "./support-triage/index.js";

/**
 * What every shipped agent needs to be constructed. It is an object rather than
 * a positional list because agents keep arriving with their own dependencies —
 * the Sentinel needs an email adapter and the portal URL for its
 * approval-gated report send.
 */
export interface AgentRegistryDeps {
  integrations: AgentIntegrations;
  email: EmailAdapter;
  portalBaseUrl: string;
}

export function agentRegistry(deps: AgentRegistryDeps): Record<string, AgentDefinition> {
  const defs = [
    hostingGuardDog(deps.integrations),
    supportTriage(deps.integrations),
    adPerformanceSentinel({ email: deps.email, portalBaseUrl: deps.portalBaseUrl }),
  ];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
