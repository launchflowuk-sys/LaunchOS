import type { AgentPolicy, ToolDefinition } from "./types.js";

export type PolicyDecision = "execute" | "queue_approval";

export function decide(tool: ToolDefinition, policy: AgentPolicy): PolicyDecision {
  if (policy === "approval_all") return "queue_approval";
  return tool.risk === "safe" ? "execute" : "queue_approval";
}
