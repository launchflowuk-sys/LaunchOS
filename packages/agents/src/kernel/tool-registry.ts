import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * JSON Schema keywords the Claude tool API refuses inside a strict tool
 * schema. Zod emits them for `.min()`, `.max()`, `.int().min()`, `.regex()`
 * and friends, and the API answers with `tools.N.custom: For 'integer' type,
 * properties maximum, minimum are not supported` and the whole run fails.
 * The bounds still hold: every tool input is parsed by its Zod schema before
 * the tool runs, so a value outside them is refused there, with a message the
 * model can act on.
 */
const UNSUPPORTED_IN_TOOL_SCHEMA = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
]);

/** A deep copy of `schema` without the keywords above, at every level. */
export function claudeToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeToolSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_IN_TOOL_SCHEMA.has(key)) continue;
    out[key] = claudeToolSchema(value);
  }
  return out;
}

// Tool names are sent to the Claude API and must match ^[a-zA-Z0-9_-]{1,64}$,
// so use underscores (e.g. "uptime_check_site"), not dots.
export function toClaudeTools(tools: ToolDefinition[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      ...(claudeToolSchema(z.toJSONSchema(t.input)) as Anthropic.Beta.BetaTool["input_schema"]),
      additionalProperties: false,
    },
    strict: true,
  }));
}

export function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
