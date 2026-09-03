import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

export type AgentRunTrigger = "cron" | "event" | "manual" | "resume";
export type AgentStepKind = "llm" | "tool_call" | "tool_result" | "approval_requested" | "note";
export type AgentRunStatus = "completed" | "awaiting_approval" | "failed";

export interface RecordStepInput {
  toolName?: string;
  input?: unknown;
  output?: unknown;
  tokensIn?: number;
  tokensOut?: number;
}

export class RunRecorder {
  private seq = 0;

  private constructor(
    private readonly db: Db,
    readonly organisationId: string,
    readonly runId: string,
  ) {}

  static async open(
    db: Db,
    organisationId: string,
    agentKey: string,
    trigger: AgentRunTrigger,
    input: Record<string, unknown>,
  ): Promise<RunRecorder> {
    const [run] = await db.insert(schema.agentRuns).values({ organisationId, agentKey, trigger, input }).returning();
    return new RunRecorder(db, organisationId, run!.id);
  }

  async step(kind: AgentStepKind, data: RecordStepInput) {
    this.seq += 1;
    const [row] = await this.db
      .insert(schema.agentSteps)
      .values({
        organisationId: this.organisationId,
        runId: this.runId,
        seq: this.seq,
        kind,
        toolName: data.toolName ?? null,
        input: data.input ?? {},
        output: data.output ?? {},
        tokensIn: data.tokensIn ?? null,
        tokensOut: data.tokensOut ?? null,
      })
      .returning();
    return row!;
  }

  async addTokens(tokensIn: number, tokensOut: number): Promise<void> {
    const [run] = await this.db
      .select({ i: schema.agentRuns.tokensIn, o: schema.agentRuns.tokensOut })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, this.runId));
    await this.db
      .update(schema.agentRuns)
      .set({ tokensIn: (run?.i ?? 0) + tokensIn, tokensOut: (run?.o ?? 0) + tokensOut })
      .where(eq(schema.agentRuns.id, this.runId));
  }

  async finish(status: AgentRunStatus, summary: string, error?: string, pending?: Record<string, unknown>): Promise<void> {
    await this.db
      .update(schema.agentRuns)
      .set({
        status,
        summary,
        error: error ?? null,
        finishedAt: status === "awaiting_approval" ? null : new Date(),
        metadata: pending ? { pending } : {},
      })
      .where(eq(schema.agentRuns.id, this.runId));
  }
}
