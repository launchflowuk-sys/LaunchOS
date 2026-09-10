import { MockBriefWriter } from "./mock.js";
import { OpenAiBriefWriter } from "./openai.js";
import type { BriefWriterAdapter } from "./types.js";

/**
 * Mock unless both a key and an explicit model are set — mock-first, per rule 4.
 *
 * Both, not either, and no default model id. A guessed id either 404s
 * confusingly or silently runs something older and cheaper than intended,
 * which here means worse briefs going to clients with nothing to show why.
 * Same reasoning and the same two variables as the site generator, so one
 * OpenAI setup covers both.
 */
export function createBriefWriterFromEnv(env: NodeJS.ProcessEnv = process.env): BriefWriterAdapter {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) return new MockBriefWriter();
  return new OpenAiBriefWriter({ apiKey, model, ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}) });
}
