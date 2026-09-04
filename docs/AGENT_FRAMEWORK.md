# Agent Framework

The agent framework is a small kernel in `packages/agents/src/kernel` that any number of agents plug into. Agents are data: a key, a prompt, a trigger and a list of typed tools.

## Types

```ts
export type ToolRisk = "safe" | "requires_approval";

export interface ApprovalDescription {
  title: string;                            // replaces the approval's title
  summary: string;                          // what will actually happen, in one or two sentences
  details?: Record<string, unknown>;        // labelled facts, including the exact text being sent
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;                 // "uptime.check_site"
  description: string;          // shown to the model
  input: TInput;                // Zod schema, converted to strict JSON Schema
  risk: ToolRisk;
  execute: (input: z.infer<TInput>, ctx: AgentContext) => Promise<TOutput>;
  // Optional, and only meaningful on a requires_approval tool. See "Describing
  // an approval" below.
  describeApproval?: (input: z.infer<TInput>, ctx: AgentContext) => Promise<ApprovalDescription>;
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
  approvedByUserId?: string;    // resume path only: the human who released this tool call
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
   - `queue_approval`: call the tool's `describeApproval` if it has one, insert `approvals` with the tool name, the input and that description, record an `approval_requested` step, park the run as `awaiting_approval`, and stop the loop. The pending assistant message and tool_use id are stored in `agent_runs.metadata.pending` so the run can resume.
8. Append all tool results as one user message and loop until `maxTurns`.

Steps 3 to 8 live in `run-loop.ts`, not in `run-agent.ts`. Both `runAgent` and `resumeAgent` call it, so a first run and a resumed one cannot drift apart in how they handle tool results, parking or the turn limit.

## Resume (`resume-agent.ts`, the `agent.resume` job)

Parking writes the whole loop state onto the run:

```ts
agent_runs.metadata.pending = {
  messages,              // the conversation so far, including the parked assistant turn
  completedResults,      // tool_results for the calls in this batch that already ran
  awaitingToolUseId,     // the tool_use block a human is looking at
  remainingToolUseIds,   // the rest of the batch, which never ran
}
```

**Who writes the decision.** `decideApproval` (`packages/core/src/approvals/decide-approval.ts`) is the *only* writer of `approvals.status`, `decided_by`, `decided_at` and `decision_note`, for a run-backed approval exactly as for a human-raised one. One conditional UPDATE (`WHERE status = 'pending' AND decided_at IS NULL`) claims the row, so of any number of concurrent decisions exactly one wins; the losers get `alreadyDecided` and enqueue nothing. The kernel never writes those columns — it reads them. What tells the kernel a decision has not been carried out yet is therefore **`agent_runs.metadata.pending`**, the parked loop state, which `runLoop` clears the moment the run finishes or re-parks.

`resumeAgent(def, { runId, approvalId, … })` then:

1. Loads the run and the approval, both scoped to the organisation. The approval must belong to this run, must already carry a decision (a still-`pending` row means nobody decided, so there is nothing to resume), and its `payload.toolUseId` must equal `awaitingToolUseId` — that binding is what stops a stale row being replayed against a later parked call. Anything inconsistent throws rather than guessing.
2. Reopens the recorder. `RunRecorder.reopen` claims the run in one conditional UPDATE (`WHERE status = 'awaiting_approval'`), so two deliveries cannot both execute the tool, stamps `metadata.resume = { approvalId, claimedAt }`, and continues the existing `seq` rather than restarting at 0, which the `agent_steps_run_seq` unique index would reject.
3. Takes the verdict, the note and the approver from the approvals row. `opts.decision` and `opts.note` on the job are a cross-check only: a payload that disagrees with the row is logged and ignored, and there is deliberately no `decidedByUserId` on the job at all, so a malformed or missing field can never silently re-attribute an outward action to the agent.
4. **Approved:** executes the tool directly — the policy gate is not consulted a second time, because the human *is* the gate. `approvals.decided_by` reaches the tool as `ctx.approvedByUserId`, so a tool that records who acted names the approver rather than the agent. A tool that throws becomes an `is_error` tool_result rather than losing the run.
   **Rejected:** substitutes `rejected by human: <note>` as an `is_error` tool_result and records a `note` step.
5. Marks every `remainingToolUseIds` entry `skipped pending approval`, in the trace as well as to the model.
6. Re-enters the shared `runLoop` with `[...pending.messages, { role: "user", content: results }]`.

If a resume dies partway, the run is left `running`; a later attempt for the *same* approval finishes it `failed` and notifies the owner, because an approved outward action silently vanishing is the one failure nothing else surfaces. See "When a resume fails" for the three predicates that have to hold first.

### The resume contract: decide → fast-path enqueue → sweeper

**A decision is final the moment `decideApproval` commits.** Nothing releases it and there is no inverse function, because the two halves are not the same fact: the decision is a row, the `agent.resume` job is *delivery*.

1. **Decide.** `/approvals` calls `decideApproval`, which claims the row and stamps status, `decided_by`, `decided_at` and the note, then records `approval.approved_queued` / `approval.rejected_queued` in `audit_log`.
2. **Fast path.** The same request enqueues `agent.resume` under `resume:<approvalId>`. If that send throws, or returns `null` (pg-boss deduped it), the failure is logged and the approver is still told "Decision recorded". `boss.send` is a single INSERT whose promise can reject *after* the row committed, so a rejection means "unknown", never "did not happen" — and undoing the decision on it would revert an outward action that may already have been sent, silently, with no audit row. A dedupe is not a failure either: the job is a bare pointer that reads this very row, so the queued one carries out exactly this decision.
3. **Sweeper.** `approvals.resume-sweep` (cron, every minute, `apps/worker/src/jobs/resume-sweep.ts`) re-enqueues, per organisation, every approval that is `approved`/`rejected`, has a `run_id`, was decided more than 30 seconds ago, and whose run is still `awaiting_approval` with `metadata.pending` present — under the same `resume:<approvalId>` key. It is idempotent by construction: a run that has been claimed, finished or re-parked no longer matches, and the kernel's three replay guards stand behind it. It gives up after 24 hours — a decision still parked a day later fails for a reason re-sending cannot fix, and retrying it every minute for ever would bury every real failure. Delivery is therefore at-least-once and execution is once-only; the worst case is a resume that starts a minute late.

A run-less approval (an invoice send) is decided and executed in the same request and records `approval.approved` instead.

## Describing an approval

A bare `{ "adReportId": "6f2c…" }` on the approvals screen is not a decision a human can make. A `requires_approval` tool may therefore implement `describeApproval`, which the kernel calls while parking the run; the result sets `approvals.title` and `approvals.payload.description`, and `/approvals` renders the summary and every detail above the raw payload.

Two rules:

- **Facts come from our rows.** `describeApproval` reads the database — the client, the recipient address, the zone, the period, the current status. It never restates the model's claims as fact. What it does copy from the tool input is the *text being released* (the drafted reply, the DNS value, the replacement page), because that is exactly what the approver has to read.
- **It is best effort.** A description that throws is logged and dropped; the run still parks with the default title. A lookup failure must never turn an approval gate into silence.

`reports_send_to_client`, `messages_reply_to_client`, `dns_update_record` and `cms_update_content` all implement it.

## When a resume fails

`resumeAgent` flips the run to `running` before the approved tool executes, so from that point every failure has to land somewhere terminal. Everything from loading the parked run onwards sits in one try/catch:

- The run is finished `failed`, with `notifyOwner` telling the owner an approved action did not complete, only when all three hold: it is `running`; `metadata.resume.approvalId` is *this* approval; and that claim is more than five minutes old. A live resume stamped `claimedAt` when it reopened the run, so it is never eligible — without that check, a pg-boss redelivery arriving mid-flight would mark a working run `failed` and tell Shoji an approved send failed while it was still running.
- Anything else — a spent approval, an approval bound to a different `tool_use`, another organisation's run, a run some other approval is driving, a claim that is still fresh — is logged, left exactly as it was, and the error is thrown to the caller so pg-boss retries. A stale approval must never be able to kill a run that is legitimately waiting or working.

The worker's `agent.resume` handler treats a run that is already `completed` or `failed` as an idempotent no-op with a log line, so a pg-boss retry after a partial failure does not fail identically five times over. A run left `running` by a killed delivery is deliberately *not* skipped: it is the one case the kernel still has to close out.

**The five-minute floor is not a lease, so a second sweeper closes the rest.** `agent-runs.stuck-sweep` (cron, every ten minutes) fails any run still `running` that has recorded no step for thirty minutes and whose `metadata.resume.claimedAt`, if it has one, is at least that old — writing `agent.run_stranded` to `audit_log` and notifying the owner. A run that is visibly working is never eligible however long it takes, which is what stops it killing a legitimately long Opus run.

The other half of that is `RunRecorder.finish`, whose UPDATE carries `status = 'running'`. Every caller enters from `running` (`open` inserts it, `reopen` claims it), so a `false` return always means something else declared the run terminal first; the late delivery then logs `run was already finished by something else` and stops. Without the predicate a resume that came back to life after the sweeper had failed it would write `completed` over the top, and `agent_runs` would contradict the notification the owner actually read.

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

Every run produces a readable trace in the admin portal under Agent Runs: prompt, each tool call with input and output, approvals raised, token usage, and the summary. `audit_log` receives a row for every business record the agent changes, with `actor_kind = "agent"` and `actor_id = agentKey` — except where a human released the tool call and the tool passes `ctx.approvedByUserId` through, in which case the row names them (`actor_kind = "user"`). The decision was theirs; the trail should say so.

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
- Approval flow: the reply parks the run as `awaiting_approval` with an `approvals` row carrying `{ toolName, input, toolUseId, description }` — the description names the client, the thread subject and the drafted body. Approving resumes the run, which writes the `queued` message; the worker's `outbound.message` job then calls `sendQueuedMessage` through the `EmailAdapter`. Rejecting resumes with a `rejected by human: <note>` tool result and nothing is queued.

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
| `reports_send_to_client` | **requires_approval** | Moves the report to `approved` if it is still a `draft`, then `sendAdReport` through the `EmailAdapter`: emails the client the portal link and moves the report to `sent`. |

- Prompt: list accounts → read signals per account → one ticket and one draft report per flagged account. It may quote only figures a tool returned, creates nothing when no account is flagged, and never sends without being asked to.
- Output: one internal ticket per flagged account and a draft report per account. Sending is a separate approval.
- Approval flow: `reports_send_to_client` parks the run with an `approvals` row carrying `{ toolName, input, toolUseId, description }`. The description is the point: the card names the client, the recipient address, the reporting period and the whole `summaryMd`, all read from `ad_reports`, `ad_accounts` and `clients`, so the approver reads the report before releasing it. Approving resumes the run, which stamps the draft `approved` **attributed to the approver** (`ctx.approvedByUserId`, `actorKind: "user"`), emails the client `<portalBaseUrl>/portal/reports` and sets `ad_reports.status = "sent"`. Rejecting resumes with a rejection tool result and nothing leaves the building.
- So a report reaches `approved` by exactly two routes, both of them a person: Approve on `/ads/reports` after reading the draft, or Approve on `/approvals` after reading the same summary on the card. The agent never approves its own report — it acts on a decision, and the audit rows name whoever made it. A report a person already approved by hand is not re-approved, so the audit log carries no second, no-op `ad_report.approved` row.

`tickets_create` is a factory (`makeTicketsCreate(agentKey)`) precisely so two agents can share one tool without lying about who acted; `ticketsCreate` remains the bound export the Hosting Guard-Dog uses.

## Registry

`agentRegistry({ integrations, email, portalBaseUrl })` returns every shipped agent keyed by `key`. It takes an object because agents keep arriving with their own dependencies; the worker builds it once at boot from the same `EmailAdapter` it uses for outbound mail and `APP_URL` for the portal link.

## Adding an agent

1. Create `packages/agents/src/agents/<key>/index.ts` exporting an `AgentDefinition`.
2. Register in `packages/agents/src/agents/index.ts`.
3. Write an integration test with `FakeLlmClient` that asserts rows in `agent_runs`, `agent_steps` and the domain tables.
4. Enable it in Settings → Agents (writes `agent_enablement`).
