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
  /**
   * Set only on the resume path: the signed-in human who approved this tool
   * call. A tool that records who acted attributes the write to them rather
   * than to the agent, because the decision was theirs.
   */
  approvedByUserId?: string;
}

/**
 * What a human is shown before they release an approval-gated tool call.
 * Built from our own database rows — never from model text — so the card on
 * /approvals states what will actually happen, not what the agent claims.
 */
export interface ApprovalDescription {
  /** Replaces the approval's title. One line, no full stop. */
  title: string;
  /** A sentence or two naming the real-world effect. */
  summary: string;
  /** Labelled facts rendered under the summary; the exact text being sent belongs here. */
  details?: Record<string, unknown>;
}

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  input: TInput;
  risk: ToolRisk;
  execute: (input: z.infer<TInput>, ctx: AgentContext) => Promise<TOutput>;
  /**
   * Optional, and only meaningful on a `requires_approval` tool: the kernel
   * calls it while parking the run and stores the result on the approval.
   * It must read our own rows; anything it copies from `input` is text the
   * approver needs to read (the body of a reply, the value of a DNS record),
   * never a fact about the system.
   */
  describeApproval?: (input: z.infer<TInput>, ctx: AgentContext) => Promise<ApprovalDescription>;
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
