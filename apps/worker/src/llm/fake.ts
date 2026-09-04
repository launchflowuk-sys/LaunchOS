import { text, toolUse, type LlmClient, type LlmRequest, type LlmResponse } from "@launchos/agents";

/**
 * The scripted stand-in the worker uses when `LLM=fake`.
 *
 * `FakeLlmClient` takes a fixed list of responses, which is right for a unit
 * test and useless for a running worker: it does not know how many turns an
 * agent will take, and an exhausted list throws. This client answers from the
 * request instead, so a worker started with `LLM=fake` can carry a real
 * `ticket.created` all the way to a parked approval and, once a human releases
 * it, to a sent reply — the Plan 4 §7 acceptance — with no API key and no
 * nondeterminism.
 *
 * It is deliberately dumb. It reads nothing it was not handed, decides on the
 * tool list and the messages already in the transcript, and never invents an
 * id: the conversation it replies on is the one in the run payload.
 */
const REPLY_TOOL = "messages_reply_to_client";
const NO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/**
 * The body every scripted reply carries. Exported so an acceptance test can
 * recognise the message it should watch reach `sent` without depending on the
 * approval payload.
 */
export const FAKE_REPLY_BODY =
  "Thanks for letting us know — we have picked this up and will come back to you with an update. " +
  "The LaunchFlow team. (Scripted reply from the fake LLM; LLM=fake.)";

export class FakeAgentLlmClient implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const conversationId = conversationIdOf(req);
    const canReply = req.tools.some((tool) => tool.name === REPLY_TOOL);
    // One draft per run: once the transcript already has the tool_use, the run
    // is being resumed after approval and the only thing left is to finish.
    if (canReply && conversationId && !alreadyDrafted(req)) {
      return {
        content: [toolUse("fake_reply_1", REPLY_TOOL, { conversationId, body: FAKE_REPLY_BODY })],
        stopReason: "tool_use",
        usage: { ...NO_USAGE },
      };
    }
    return {
      content: [text("Scripted fake run: nothing further to do.")],
      stopReason: "end_turn",
      usage: { ...NO_USAGE },
    };
  }
}

/** `runAgent` puts the run payload in as the first user message, as JSON. */
function conversationIdOf(req: LlmRequest): string | null {
  const first = req.messages[0];
  if (!first || typeof first.content !== "string") return null;
  try {
    const payload: unknown = JSON.parse(first.content);
    if (typeof payload !== "object" || payload === null) return null;
    const value = (payload as { conversationId?: unknown }).conversationId;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function alreadyDrafted(req: LlmRequest): boolean {
  return req.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => {
        const b = block as { type?: unknown; name?: unknown };
        return b.type === "tool_use" && b.name === REPLY_TOOL;
      }),
  );
}
