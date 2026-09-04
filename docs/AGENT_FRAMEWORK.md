# Agent Framework

The agent framework is a small kernel in `packages/agents/src/kernel` that any number of agents plug into. Agents are data: a key, a prompt, a trigger and a list of typed tools.

## Types

```ts
export type ToolRisk = "safe" | "requires_approval";

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;                 // "uptime.check_site"
  description: string;          // shown to the model
  input: TInput;                // Zod schema, converted to strict JSON Schema
  risk: ToolRisk;
  execute: (input: z.infer<TInput>, ctx: AgentContext) => Promise<TOutput>;
}

export type AgentTrigger =
  | { kind: "cron"; schedule: string; timezone: string }
  | { kind: "event"; event: string }
  | { kind: "manual" };

export interface AgentDefinition {
  key: string;                  // "hosting-guard-dog"
  name: string;
  description: string;
  trigger: AgentTrigger;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;             // hard stop on LLM round-trips
  model?: string;               // defaults to env AGENT_MODEL, "claude-opus-5"
}

export interface AgentContext {
  organisationId: string;
  runId: string;
  db: Db;
  logger: Logger;
  now: () => Date;
}

export interface AgentRunResult {
  runId: string;
  status: "completed" | "awaiting_approval" | "failed";
  summary: string;
}
```

## Run loop (`run-agent.ts`)

1. `RunRecorder.open()` inserts `agent_runs` with `status = running`.
2. Build the message list: system prompt, then a user message containing the JSON payload.
3. Call `LlmClient.complete({ system, messages, tools })`.
4. Record an `llm` step with token usage.
5. If `stop_reason` is `end_turn`, record the final text as the run summary and finish `completed`.
6. If `stop_reason` is `refusal`, finish the run `failed` with `agent_runs.error = "refusal"`. The refused run is visible in Agent Runs and a human picks it up from there; the automatic escalation ticket arrives in Plan 2.
7. If `stop_reason` is `tool_use`, for every tool_use block (in parallel):
   - Validate input with the tool's Zod schema. Invalid input becomes a `tool_result` with `is_error: true`.
   - Ask `PolicyGate.decide(tool, policy)`.
   - `execute`: run the tool, record `tool_call` and `tool_result` steps, collect the result block.
   - `queue_approval`: insert `approvals` with the tool name and input, record an `approval_requested` step, park the run as `awaiting_approval`, and stop the loop. The pending assistant message and tool_use id are stored in `agent_runs.metadata.pending` so the run can resume.
8. Append all tool results as one user message and loop until `maxTurns`.

Resume (`agent.resume` job): loads the parked run, executes the approved tool (or substitutes a rejection tool_result), and continues the loop from step 3.

## LLM client (`llm.ts`)

`AnthropicLlmClient` uses `@anthropic-ai/sdk` beta messages with:

- `model: "claude-opus-5"` by default
- `thinking: { type: "adaptive" }`
- `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`
- `max_tokens: 16000`
- tools with `strict: true`

`FakeLlmClient` takes a scripted list of responses for tests. The kernel is tested entirely against the fake.

## Policy gate (`policy-gate.ts`)

| `AGENT_POLICY` | `safe` tool | `requires_approval` tool |
|---|---|---|
| `safe` (default) | execute | queue_approval |
| `approval_all` | queue_approval | queue_approval |

Per-organisation overrides live in `agent_enablement.config.policy`.

## Recording

Every run produces a readable trace in the admin portal under Agent Runs: prompt, each tool call with input and output, approvals raised, token usage, and the summary. `audit_log` receives a row for every business record the agent changes, with `actor_kind = "agent"` and `actor_id = agentKey`.

## The three agents

### hosting-guard-dog
- Trigger: `event: incident.opened` (the deterministic monitor job opens incidents).
- Tools: `uptime.check_site`, `hosting.get_resources`, `incidents.update`, `tickets.create`.
- Output: incident summary in Markdown, an internal ticket, incident status `acknowledged`.

### support-triage
- Trigger: `event: ticket.created` (emitted by `ingestInboundEmail` and by `createTicket`). Payload: `{ ticketId, clientId, conversationId }`.
- `maxTurns: 10`.
- Tools (nine, in the order the prompt uses them):

| Tool | Risk | What it does |
|---|---|---|
| `tickets_get` | safe | The ticket, its client, and the last 20 messages on the conversation. |
| `knowledge_search` | safe | Ranked published knowledge articles; the prompt caps it at two searches. |
| `tickets_update` | safe | `category`, `severity`, `status: "triaged"` and the `triage` json. |
| `tasks_create` | safe | A support task linked to the ticket when a human must do the work. |
| `tickets_assign` | safe | Assigns the least-loaded active member (`pickLeastLoadedStaff`). |
| `tickets_escalate` | safe | Marks the ticket escalated and notifies the owner in-app. |
| `messages_reply_to_client` | **requires_approval** | Writes the reply as a `queued` outbound message. |
| `dns_update_record` | **requires_approval** | One record on a domain we manage; the zone is read from our own rows, never from the model. |
| `cms_update_content` | **requires_approval** | One page on a client's CMS; the site ref likewise comes from our rows. |

- Prompt: classify → search the knowledge base → decide fix vs escalate → draft the reply. It never invents detail, escalates below 0.4 confidence, and uses the `tickets` table's own category and severity enums.
- Output: `tickets.category`, `tickets.severity` and `tickets.triage` set; either a drafted reply (plus any fix) parked as an approval, or an escalation with a reason and an owner notification.
- Approval flow: the reply parks the run as `awaiting_approval` with an `approvals` row carrying `{ toolName, input, toolUseId }`. Approving resumes the run, which writes the `queued` message; the worker's `outbound.message` job then calls `sendQueuedMessage` through the `EmailAdapter`. Rejecting resumes with a `rejected by human: <note>` tool result and nothing is queued.

### ad-performance-sentinel
- Trigger: `cron 0 7 * * *` Europe/London.
- Tools: `ads.list_accounts`, `ads.get_metrics`, `tickets.create`, `ads.save_draft_report`.
- Output: one internal ticket per flagged account and a draft report per account. Sending the report is a separate approval.

## Adding an agent

1. Create `packages/agents/src/agents/<key>/index.ts` exporting an `AgentDefinition`.
2. Register in `packages/agents/src/agents/index.ts`.
3. Write an integration test with `FakeLlmClient` that asserts rows in `agent_runs`, `agent_steps` and the domain tables.
4. Enable it in Settings → Agents (writes `agent_enablement`).
