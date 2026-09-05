import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

export interface LlmResponse {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  /**
   * The client for this deployment's environment.
   *
   * An organisation-level Anthropic key (one created outside a workspace)
   * is refused by the API unless every request names the workspace in an
   * `anthropic-workspace-id` header; a workspace-scoped key needs nothing.
   * `ANTHROPIC_WORKSPACE_ID` covers the first case, so an operator can use
   * whichever key they were given. The SDK reads `ANTHROPIC_API_KEY` itself.
   */
  static fromEnv(env: { ANTHROPIC_WORKSPACE_ID?: string | undefined } = process.env): AnthropicLlmClient {
    const workspace = env.ANTHROPIC_WORKSPACE_ID?.trim();
    return new AnthropicLlmClient(
      new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
    );
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create({
      model: req.model,
      max_tokens: 16000,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return {
      content: res.content,
      stopReason: res.stop_reason,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

export class FakeLlmClient implements LlmClient {
  public readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: LlmResponse[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.responses.shift();
    if (!next) throw new Error("FakeLlmClient: no scripted response left");
    return next;
  }
}

export const text = (t: string): Anthropic.Beta.BetaContentBlock =>
  ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaContentBlock;

export const toolUse = (id: string, name: string, input: unknown): Anthropic.Beta.BetaContentBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaContentBlock;
