import { MockSiteGenerator } from "./mock.js";
import { OpenAiSiteGenerator } from "./openai.js";
import type { SiteGeneratorAdapter } from "./types.js";

/**
 * Mock unless both an API key and an explicit model are set — mock-first, per
 * rule 4.
 *
 * **Both, not either.** A key with no model would need a default model id, and
 * a guessed one either 404s confusingly or silently runs on something older and
 * cheaper than intended, producing worse sites than are being paid for. Two
 * variables, no defaults, and the mock until both arrive.
 */
export function createSiteGeneratorFromEnv(env: NodeJS.ProcessEnv = process.env): SiteGeneratorAdapter {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) return new MockSiteGenerator();
  return new OpenAiSiteGenerator({ apiKey, model, ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}) });
}
