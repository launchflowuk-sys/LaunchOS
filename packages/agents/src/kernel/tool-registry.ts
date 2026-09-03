import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

// Tool names are sent to the Claude API and must match ^[a-zA-Z0-9_-]{1,64}$,
// so use underscores (e.g. "uptime_check_site"), not dots.
export function toClaudeTools(tools: ToolDefinition[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      ...(z.toJSONSchema(t.input) as Anthropic.Beta.BetaTool["input_schema"]),
      additionalProperties: false,
    },
    strict: true,
  }));
}

export function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
