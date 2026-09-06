import { renderPdf } from "@launchos/channels/pdf";
import { DeliveryRefused, sendDeliveryReport } from "@launchos/core";
import type { Db } from "@launchos/db";

/**
 * The only place a handover can actually go out.
 *
 * `sendDeliveryReport` renders a PDF, and `playwright` is a dependency of this
 * process and deliberately not of `apps/web` — a send from a Server Action
 * works on a laptop and fails on Coolify. So the admin page queues, and this
 * consumes, exactly as `proposals-send.ts` does for a proposal.
 *
 * Refusals are logged and swallowed rather than thrown. Every one of them is a
 * business answer that will still be true on the retry — the project was
 * cancelled, it is already signed, nobody on the client has an email address —
 * so failing the job would only spend six attempts arriving at the same
 * sentence. The page checks all three before it queues, so reaching one here
 * means the world changed between the press and the run, which is worth a log
 * line and nothing more. Anything else throws and pg-boss retries it.
 */

/** Ids only: the worker reads the rows itself, as it does for a proposal send. */
export interface DeliverySendJob {
  organisationId: string;
  projectId: string;
  /** Who pressed the button, so the audit trail names a person rather than the worker. */
  actorId?: string;
}

export interface DeliverySendDeps {
  readonly db: Db;
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

export type DeliverySendResult =
  | { sent: true; projectId: string; documentId: string; recipients: number }
  | { sent: false; projectId: string; reason: string };

export async function handleDeliverySend(deps: DeliverySendDeps, job: DeliverySendJob): Promise<DeliverySendResult> {
  const logger = deps.logger ?? console;
  try {
    const result = await sendDeliveryReport(
      deps.db,
      job.organisationId,
      {
        projectId: job.projectId,
        actorKind: "user",
        ...(job.actorId ? { actorId: job.actorId } : {}),
      },
      { render: renderPdf },
      deps.env,
    );
    return { sent: true, projectId: job.projectId, documentId: result.document.id, recipients: result.messages.length };
  } catch (error) {
    if (error instanceof DeliveryRefused) {
      logger.warn({ projectId: job.projectId, reason: error.reason }, `handover not sent: ${error.message}`);
      return { sent: false, projectId: job.projectId, reason: error.reason };
    }
    throw error;
  }
}
