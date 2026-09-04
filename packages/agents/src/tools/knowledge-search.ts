import { searchKnowledge } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const knowledgeSearch = defineTool({
  name: "knowledge_search",
  description: "Search the published knowledge base. Returns ranked title, slug and an excerpt. Cite the slug in your reply.",
  input: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(10).default(5) }),
  risk: "safe",
  execute: async (input, ctx) => ({
    hits: await searchKnowledge(ctx.db, ctx.organisationId, input.query, input.limit),
  }),
});
