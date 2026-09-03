/**
 * Static catalogue of agents the admin portal can enable per organisation.
 *
 * Plan 2 replaces this with `agentRegistry` from `@launchos/agents`, which is
 * the single source of truth once more than one agent ships.
 */
export type AgentCatalogEntry = { key: string; name: string };

export const agentCatalog: readonly AgentCatalogEntry[] = [
  { key: "hosting-guard-dog", name: "Hosting Guard-Dog" },
];
