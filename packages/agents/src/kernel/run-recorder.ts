import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";

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

  /**
   * Continues an existing run after an approval decision. `seq` picks up from
   * the highest step already recorded so the (run_id, seq) unique index holds
   * and the trace in the admin portal reads as one story.
   */
  static async reopen(db: Db, organisationId: string, runId: string): Promise<RunRecorder> {
    // Claim the run in one statement: a check-then-update would let two
    // approvals resume the same parked run and execute the tool twice.
    const [claimed] = await db
      .update(schema.agentRuns)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          eq(schema.agentRuns.organisationId, organisationId),
          eq(schema.agentRuns.status, "awaiting_approval"),
          isNull(schema.agentRuns.deletedAt),
        ),
      )
      .returning({ id: schema.agentRuns.id });
    if (!claimed) throw await RunRecorder.claimFailure(db, organisationId, runId);

    const [last] = await db
      .select({ seq: schema.agentSteps.seq })
      .from(schema.agentSteps)
      .where(eq(schema.agentSteps.runId, runId))
      .orderBy(desc(schema.agentSteps.seq))
      .limit(1);

    const recorder = new RunRecorder(db, organisationId, runId);
    recorder.seq = last?.seq ?? 0;
    return recorder;
  }

  /** Explains a lost claim. Read-only: the claim itself already decided. */
  private static async claimFailure(db: Db, organisationId: string, runId: string): Promise<Error> {
    const [run] = await db
      .select({ status: schema.agentRuns.status, deletedAt: schema.agentRuns.deletedAt })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.organisationId, organisationId)));
    if (!run || run.deletedAt) return new Error(`agent run ${runId} not found in organisation`);
    return new Error(`agent run ${runId} is ${run.status}, expected awaiting_approval`);
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
