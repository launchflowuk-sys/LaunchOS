import type { Integrations } from "@launchos/integrations";

/**
 * The slice of `Integrations` the shipped agents actually consume. Narrowing to
 * a `Pick` keeps `packages/agents` decoupled from members added for other
 * plans (payments, ads), which would otherwise force every caller and test
 * fixture to construct adapters no agent uses. Plan 5 widens this as the
 * payments and ad-sentinel agents land.
 */
export type AgentIntegrations = Pick<Integrations, "uptime" | "hosting">;
