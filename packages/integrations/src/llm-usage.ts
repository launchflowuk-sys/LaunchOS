/**
 * What one model call consumed.
 *
 * Lives in `integrations` and is returned outward rather than recorded here,
 * because this package is a leaf: it cannot import `core`, and pricing usage
 * needs the rate card that `core` owns. An adapter's job is to report honestly
 * what the provider said it used; deciding what that costs is somebody else's.
 *
 * Optional on every result it appears on. A mock adapter has no real usage to
 * report, and a provider that stops sending `usage` must degrade to "not
 * metered" rather than to zero — a zero is indistinguishable from a free call.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache. Priced far lower. */
  cachedInputTokens?: number;
  /** The model that actually ran, which is what the rate card keys on. */
  model: string;
}

/** OpenAI's `usage` block, as the chat completions API returns it. */
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Reads OpenAI's usage block, or returns undefined.
 *
 * Undefined rather than zeroes when the block is missing or unusable: the
 * caller records nothing, `unpricedUsage` stays quiet, and nobody is told a
 * call was free when the truth is that it was not measured.
 */
export function openAiUsage(payload: unknown, model: string): LlmUsage | undefined {
  const usage = (payload as { usage?: OpenAiUsage } | null)?.usage;
  if (!usage) return undefined;
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  if (inputTokens <= 0 && outputTokens <= 0) return undefined;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(cached) && cached > 0 ? { cachedInputTokens: cached } : {}),
    model,
  };
}
