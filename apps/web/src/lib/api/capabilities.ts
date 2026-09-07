import type { AgentCatalogEntry } from "@/lib/agent-catalog";

/**
 * What LaunchOS can do, answered by generating rather than remembering.
 *
 * Spec point 9: a hardcoded list goes stale the moment a capability is added,
 * and goes stale *silently* — the new thing simply never appears and nobody
 * notices until somebody asks why Mr. Green cannot do the obvious. Everything
 * here is derived from `agentCatalog()`, which is itself derived from the same
 * `agentRegistry` the worker runs. A tool registered next year shows up the day
 * it lands.
 */

export type Delegability =
  /** Reads or writes only our own rows. Nothing leaves the building. */
  | "automatic"
  /** Acts outward. Waits for a person, and keeps waiting even under supervised autonomy. */
  | "always_asks";

export interface CapabilityTool {
  readonly name: string;
  readonly requiresApproval: boolean;
  readonly delegability: Delegability;
}

export interface Capability {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly trigger: string;
  /** `true` on, `false` switched off, `null` never configured — three states, not two. */
  readonly enabled: boolean | null;
  readonly tools: readonly CapabilityTool[];
}

export interface CapabilitySummary {
  readonly agents: number;
  readonly enabled: number;
  readonly tools: number;
  readonly automatic: number;
  readonly alwaysAsks: number;
}

/**
 * Whether a capability could ever run without a person.
 *
 * **Approval-gated means never delegated, and that is the deliberate default.**
 * Rule 2 says agents do not act outward without approval; supervised autonomy
 * (spec point 12) will let Shoji hand over selected categories, and when it
 * does, each one gets loosened *explicitly* rather than by having been left
 * un-marked. A default of "delegable unless someone remembered to say
 * otherwise" is how a tool added in six months quietly gains the right to
 * message a client.
 *
 * **What this cannot decide, and Phase 6 must.** The hard floor in spec point 4
 * is price, dates, money and legal — and none of the five approval-gated tools
 * is inherently any of those. `messages_reply_to_client` might say "your site
 * is back up" or it might say "that will be £2,000"; the floor is a property of
 * the *content*, not of the tool. So it cannot be classified here, and pretending
 * otherwise would produce a catalogue that looks authoritative and is not. When
 * autonomy is built, the content gets screened at send time, and this rule moves
 * into `packages/agents` so the worker enforces the same thing it advertises.
 */
export function delegabilityOf(tool: { requiresApproval: boolean }): Delegability {
  return tool.requiresApproval ? "always_asks" : "automatic";
}

export function buildCapabilities(
  catalog: readonly AgentCatalogEntry[],
  enablement: Readonly<Record<string, boolean>>,
): { capabilities: Capability[]; summary: CapabilitySummary } {
  const capabilities = catalog.map((agent) => ({
    key: agent.key,
    name: agent.name,
    description: agent.description,
    trigger: agent.trigger,
    // `?? null` rather than `?? false`: an agent nobody has configured has not
    // been turned off, and telling Shoji it was would be a small lie he might
    // act on.
    enabled: agent.key in enablement ? enablement[agent.key]! : null,
    tools: agent.tools.map((tool) => ({
      name: tool.name,
      requiresApproval: tool.requiresApproval,
      delegability: delegabilityOf(tool),
    })),
  }));

  const tools = capabilities.flatMap((c) => c.tools);
  return {
    capabilities,
    summary: {
      agents: capabilities.length,
      enabled: capabilities.filter((c) => c.enabled === true).length,
      tools: tools.length,
      automatic: tools.filter((t) => t.delegability === "automatic").length,
      alwaysAsks: tools.filter((t) => t.delegability === "always_asks").length,
    },
  };
}
