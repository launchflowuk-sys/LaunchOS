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
| `tickets_get` | safe | The ticket, its client, and the first 20 messages on the conversation (oldest first). |
| `knowledge_search` | safe | Ranked published knowledge articles; the prompt caps it at two searches. |
| `tickets_update` | safe | `category`, `severity`, `status: "triaged"` and the `triage` json. |
| `tasks_create` | safe | A support task linked to the ticket when a human must do the work. |
| `tickets_assign` | safe | Assigns the least-loaded active member (`pickLeastLoadedStaff`). |
| `tickets_escalate` | safe | Marks the ticket escalated and notifies the owner in-app. |
| `messages_reply_to_client` | **requires_approval** | Writes the reply as a `queued` outbound message. |
| `dns_update_record` | **requires_approval** | One record on a domain we manage; the zone is read from our own rows, never from the model. |
| `cms_update_content` | **requires_approval** | One page on a client's CMS; the site ref likewise comes from our rows. |

- Prompt: classify → search the knowledge base → decide fix vs escalate → draft the reply. It never invents detail, escalates below 0.4 confidence, and uses the `tickets` table's own category and severity enums.
- Three guardrails live in the prompt rather than in code, because no schema can express them:
  - **Grounding.** An empty `knowledge_search` is not licence to answer from the model's own knowledge — it escalates or files a task instead, and names the article it relied on in the triage summary.
  - **Escalation ends the run.** Escalating stops the agent; it does not also draft a reply, so a case that needs Shoji does not arrive with an answer already half-sent.
  - **One channel to the client.** The closing sentence is an internal note for the run trace. Everything a client reads goes through `messages_reply_to_client`, which is approval-gated; nothing else the agent emits is client-visible. A payload with a null `conversationId` has no thread to reply on, and the agent says so instead of inventing an id.
- Output: `tickets.category`, `tickets.severity` and `tickets.triage` set; either a drafted reply (plus any fix) parked as an approval, or an escalation with a reason and an owner notification.
- Approval flow: the reply parks the run as `awaiting_approval` with an `approvals` row carrying `{ toolName, input, toolUseId }`. Approving resumes the run, which writes the `queued` message; the worker's `outbound.message` job then calls `sendQueuedMessage` through the `EmailAdapter`. Rejecting resumes with a `rejected by human: <note>` tool result and nothing is queued.

### ad-performance-sentinel
- Trigger: `cron 0 7 * * *` Europe/London. Payload carries `now`; the tools read the run's clock through `ctx.now()`, so a test can pin the comparison windows.
- Constructed with its own dependencies: `adPerformanceSentinel({ email, portalBaseUrl })`.
- `maxTurns: 12`.
- Tools (five, in the order the prompt uses them):

| Tool | Risk | What it does |
|---|---|---|
| `ads_list_accounts` | safe | Every `active` ad account with its client, platform and currency. |
| `ads_get_signals` | safe | `computeAccountSignals`: both 7-day windows, the ROAS and CPC deltas, `flagged` and the human-readable `reasons`. |
| `tickets_create` | safe | One internal ticket per flagged account, `category: "ads"`. Built by `makeTicketsCreate("ad-performance-sentinel")` so `audit_log.actor_id` names this agent. |
| `ads_save_draft_report` | safe | Writes `ad_reports` as `draft` with `agent_run_id` set to the current run. |
| `reports_send_to_client` | **requires_approval** | `sendAdReport` through the `EmailAdapter`: emails the client the portal link and moves the report to `sent`. |

- Prompt: list accounts → read signals per account → one ticket and one draft report per flagged account. It may quote only figures a tool returned, creates nothing when no account is flagged, and never sends without being asked to.
- Output: one internal ticket per flagged account and a draft report per account. Sending is a separate approval.
- Approval flow: `reports_send_to_client` parks the run with an `approvals` row carrying `{ toolName, input, toolUseId }`. Approving resumes the run, which emails the client `<portalBaseUrl>/portal/reports` and sets `ad_reports.status = "sent"`. Rejecting resumes with a rejection tool result and nothing leaves the building.

`tickets_create` is a factory (`makeTicketsCreate(agentKey)`) precisely so two agents can share one tool without lying about who acted; `ticketsCreate` remains the bound export the Hosting Guard-Dog uses.

## Registry

`agentRegistry({ integrations, email, portalBaseUrl })` returns every shipped agent keyed by `key`. It takes an object because agents keep arriving with their own dependencies; the worker builds it once at boot from the same `EmailAdapter` it uses for outbound mail and `APP_URL` for the portal link.

## Adding an agent

1. Create `packages/agents/src/agents/<key>/index.ts` exporting an `AgentDefinition`.
2. Register in `packages/agents/src/agents/index.ts`.
3. Write an integration test with `FakeLlmClient` that asserts rows in `agent_runs`, `agent_steps` and the domain tables.
4. Enable it in Settings → Agents (writes `agent_enablement`).
