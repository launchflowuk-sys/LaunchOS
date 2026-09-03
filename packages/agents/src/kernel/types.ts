import type { Db } from "@launchos/db";
import type { z } from "zod";

export type ToolRisk = "safe" | "requires_approval";
export type AgentPolicy = "safe" | "approval_all";
export type Logger = Pick<Console, "info" | "warn" | "error">;

export interface AgentContext {
  organisationId: string;
  runId: string;
  db: Db;
  logger: Logger;
  now: () => Date;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  input: TInput;
  risk: ToolRisk;
  execute: (input: z.infer<TInput>, ctx: AgentContext) => Promise<TOutput>;
}

export function defineTool<TInput extends z.ZodTypeAny, TOutput>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return def;
}

export type AgentTrigger =
  | { kind: "cron"; schedule: string; timezone: string }
  | { kind: "event"; event: string }
  | { kind: "manual" };

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  trigger: AgentTrigger;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
  model?: string;
}

export interface AgentRunResult {
  runId: string;
  status: "completed" | "awaiting_approval" | "failed";
  summary: string;
}
