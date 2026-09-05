import { agentRegistry, scopedCmsProvider } from "@launchos/agents/definitions";
import { createEmailAdapter } from "@launchos/channels";
import { createIntegrations } from "@launchos/integrations";
import { env } from "./env";

/**
 * What Settings → Agents can offer, read off the agent definitions themselves.
 *
 * It used to be a hand-written list of one, which is how `/settings/agents`
 * came to offer a single toggle after three agents had shipped: a hardcoded
 * catalogue only ever tells you what somebody remembered to type. Everything
 * below now comes from the same `agentRegistry` the worker runs, so an agent
 * registered in `packages/agents/src/agents/index.ts` is offered here on the
 * next request and cannot be enabled for an agent that does not exist.
 *
 * **Server only, and never from a client component.** The definitions drag in
 * the tools, the tools drag in `@launchos/core` and the database, and reading
 * `process.env` here would be meaningless in a browser bundle: the two callers
 * are a server component and a server action, and they must stay that way. It
 * deliberately imports `@launchos/agents/definitions` rather than the package
 * root, because the root also exports the kernel, and the kernel imports the
 * Anthropic SDK; nothing a page renders needs a model client.
 */
export type AgentCatalogEntry = {
  key: string;
  name: string;
  description: string;
  /** How the agent starts: a cron schedule, a domain event, or by hand. */
  trigger: string;
  /** Its tools in definition order, each with the gate the policy applies. */
  tools: readonly { name: string; requiresApproval: boolean }[];
};

function describeTrigger(trigger: { kind: string; schedule?: string; timezone?: string; event?: string }): string {
  if (trigger.kind === "cron") return `${trigger.schedule} (${trigger.timezone})`;
  if (trigger.kind === "event") return `on ${trigger.event}`;
  return "manual";
}

function buildCatalog(): readonly AgentCatalogEntry[] {
  // The same three dependencies the worker constructs the registry with. They
  // are mock-first and read only from the environment, and nothing here calls a
  // tool: the catalogue reads names and risks off the definitions and stops.
  const registry = agentRegistry({
    integrations: { ...createIntegrations(process.env), cms: scopedCmsProvider(process.env) },
    email: createEmailAdapter(process.env),
    portalBaseUrl: env.APP_URL,
  });

  return Object.values(registry)
    .map((agent) => ({
      key: agent.key,
      name: agent.name,
      description: agent.description,
      trigger: describeTrigger(agent.trigger),
      tools: agent.tools.map((tool) => ({ name: tool.name, requiresApproval: tool.risk === "requires_approval" })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cached: readonly AgentCatalogEntry[] | undefined;

/**
 * Built once per process, for the same reason `getDb` and `getAuth` are lazy:
 * `next build` must not need an environment to render a route's module graph.
 */
export function agentCatalog(): readonly AgentCatalogEntry[] {
  cached ??= buildCatalog();
  return cached;
}
