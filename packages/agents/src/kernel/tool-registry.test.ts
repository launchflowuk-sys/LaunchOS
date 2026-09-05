import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeToolSchema, toClaudeTools } from "./tool-registry.js";
import type { ToolDefinition } from "./types.js";

describe("toClaudeTools", () => {
  it("drops the numeric and length bounds the Claude tool API refuses, at every depth", () => {
    const tool: ToolDefinition = {
      name: "knowledge_search",
      description: "Search",
      risk: "safe",
      input: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(10).default(5),
        filters: z.object({ tags: z.array(z.string().max(30)).max(5) }).optional(),
      }),
      run: async () => ({}),
    } as unknown as ToolDefinition;

    const [sent] = toClaudeTools([tool]);
    const text = JSON.stringify(sent!.input_schema);
    for (const keyword of ["minimum", "maximum", "minLength", "maxLength", "maxItems"]) {
      expect(text).not.toContain(`"${keyword}"`);
    }
    // What the model needs to call the tool is still there.
    expect(text).toContain('"limit"');
    expect(text).toContain('"integer"');
    expect(text).toContain('"required"');
    expect(sent!.input_schema.additionalProperties).toBe(false);
  });

  it("leaves a schema without bounds untouched", () => {
    const schema = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] };
    expect(claudeToolSchema(schema)).toEqual(schema);
  });
});
