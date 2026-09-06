import { describeProgress, getProject, queueMilestoneNotice, type MilestoneNoticeResult } from "@launchos/core";
import type { Db } from "@launchos/db";

/**
 * The same-day note that a promise was kept.
 *
 * Sent by the `project.milestone_reached` domain event, keyed
 * `milestone-email:<milestoneId>`. Safe and not approval-gated, for the reason
 * `queueMilestoneNotice`'s own comment gives: it says only what has already
 * happened, in words we wrote, about a milestone a person ticked — the same
 * reasoning that makes the meeting no-show note a courtesy rather than a card.
 *
 * The progress figure is read here rather than passed on the event, so the
 * number in the client's email is the number their portal shows at the moment
 * it was written. Passing it on the event would let a milestone reached at
 * 09:00 and emailed at 09:05 quote a bar that had moved in between.
 */

export interface MilestoneEmailJob {
  organisationId: string;
  projectId: string;
  milestoneId: string;
}

export interface MilestoneEmailDeps {
  readonly db: Db;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface MilestoneEmailResult extends MilestoneNoticeResult {
  projectId: string;
  milestoneId: string;
  queued: number;
}

export async function handleMilestoneEmail(deps: MilestoneEmailDeps, job: MilestoneEmailJob): Promise<MilestoneEmailResult> {
  const logger = deps.logger ?? console;
  const detail = await getProject(deps.db, job.organisationId, job.projectId);
  if (!detail) {
    // A project deleted between the tick and the job. Nothing to say, and
    // nothing a retry would fix.
    logger.warn({ ...job }, "milestone email: project not found; skipping");
    return { projectId: job.projectId, milestoneId: job.milestoneId, messages: [], skipped: "already", queued: 0 };
  }
  const result = await queueMilestoneNotice(deps.db, job.organisationId, {
    projectId: job.projectId,
    milestoneId: job.milestoneId,
    progressPercent: detail.progress.percent,
    progressSentence: describeProgress(detail.progress),
  });
  return { ...result, projectId: job.projectId, milestoneId: job.milestoneId, queued: result.messages.length };
}
