import { submissionsAwaitingBrief, writeBriefVersion } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { BriefWriterAdapter } from "@launchos/integrations";

/**
 * Turns submitted questionnaires into written briefs.
 *
 * Every submission already has a readable brief before this job ever sees it,
 * so nothing here is on the critical path. A rate limit, an outage or a reply
 * that fails its schema costs a better document and nothing else — which is why
 * this sweeps rather than being called from the submit request.
 *
 * There is no claim column and no lease. "Needs writing" is derived from the
 * versions a submission already has, so a worker that dies mid-call leaves
 * nothing half-claimed and the next tick simply tries again.
 */

export interface BriefWriteDeps {
  db: Db;
  writer: BriefWriterAdapter;
  logger?: Pick<Console, "info" | "error"> | undefined;
}

export interface BriefWriteResult {
  written: number;
  failed: number;
  skipped: number;
}

/** A handful per tick. A queue of briefs is not urgent; a bill for one is. */
const PER_TICK = 5;

export async function runBriefWrites(
  deps: BriefWriteDeps,
  organisationId: string,
): Promise<BriefWriteResult> {
  const logger = deps.logger ?? console;
  const waiting = await submissionsAwaitingBrief(deps.db, organisationId, PER_TICK);

  let written = 0;
  let failed = 0;
  let skipped = 0;

  for (const submission of waiting) {
    const result = await writeBriefVersion(deps.db, organisationId, submission.id, deps.writer);
    if (result.status === "written") written += 1;
    else if (result.status === "skipped") skipped += 1;
    else {
      failed += 1;
      // Recorded rather than thrown: one bad submission must not stop the rest.
      // `writeBriefVersion` counts the attempt and rings the owner's bell once,
      // when it gives up, so a repeating failure is neither silent nor a flood.
      logger.error({ organisationId, reference: submission.reference, reason: result.reason }, "brief write failed");
    }
  }

  const result = { written, failed, skipped };
  if (written > 0 || failed > 0) logger.info({ organisationId, ...result }, "brief writes");
  return result;
}
