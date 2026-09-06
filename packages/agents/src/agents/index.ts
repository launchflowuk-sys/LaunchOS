import type { EmailAdapter } from "@launchos/channels";
import type { AgentIntegrations } from "./integrations.js";

export { cmsProviderFor, scopedCmsProvider } from "./integrations.js";
export type { AgentIntegrations, CmsProviderFactory, CmsProviderScope } from "./integrations.js";
import type { AgentDefinition } from "../kernel/types.js";
import { adPerformanceSentinel } from "./ad-performance-sentinel/index.js";
import { contentWriter } from "./content-writer/index.js";
import { hostingGuardDog } from "./hosting-guard-dog/index.js";
import { leadQualifier } from "./lead-qualifier/index.js";
import { opsBrief } from "./ops-brief/index.js";
import { supportTriage } from "./support-triage/index.js";

/**
 * This module is also the package's `./definitions` export, and that subpath
 * exists so a caller can build the registry without the kernel: the root export
 * re-exports `kernel/llm.js`, which imports the Anthropic SDK. Anything that
 * only needs to read what the agents *are* — `apps/web`'s Settings → Agents
 * catalogue — imports `@launchos/agents/definitions` and never loads a model
 * client. Keep this file free of kernel imports beyond the types.
 */

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
    contentWriter(),
    opsBrief(),
    leadQualifier(),
  ];
  return Object.fromEntries(defs.map((d) => [d.key, d]));
}
