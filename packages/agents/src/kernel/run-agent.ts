import type { Db } from "@launchos/db";
import type { LlmClient } from "./llm.js";
import { buildContext, runLoop } from "./run-loop.js";
import { RunRecorder, type AgentRunTrigger } from "./run-recorder.js";
import type { AgentDefinition, AgentPolicy, AgentRunResult, Logger } from "./types.js";

export interface RunAgentOptions {
  db: Db;
  organisationId: string;
  trigger: AgentRunTrigger;
  payload: Record<string, unknown>;
  llm: LlmClient;
  policy: AgentPolicy;
  logger: Logger;
  now?: () => Date;
}

export async function runAgent(def: AgentDefinition, opts: RunAgentOptions): Promise<AgentRunResult> {
  const recorder = await RunRecorder.open(opts.db, opts.organisationId, def.key, opts.trigger, opts.payload);
  const ctx = buildContext(opts.db, opts.organisationId, recorder.runId, opts.logger, opts.now);
  return runLoop(def, ctx, recorder, opts.llm, opts.policy, [{ role: "user", content: JSON.stringify(opts.payload) }]);
}
