import { CONTENT_WRITER_KEY } from "@launchos/agents";
import { activeServicesForClient, hasContentService } from "@launchos/core";
import { handleAgentRun, recordSkippedRun, type AgentRunDeps, type AgentRunJob } from "./agent-run.js";

/**
 * One writer run for one client's month. Sent by `content.plan-month` on the
 * 1st, and by "Draft with AI" on the client's content tab.
 *
 * Keyed `content-draft:<clientId>:<periodKey>` under a one-day window by the
 * cron fan-out (an Opus-priced run, the same reasoning as the Sentinel); a
 * manual send appends `:manual:<epochMs>` so an operator's "draft now" is
 * never deduped away. The delivery follow-on sends one too, under the cron's
 * own key, so a build handed over on the 1st cannot pay for the run twice.
 */
export interface ContentDraftJob {
  organisationId: string;
  clientId: string;
  /** `YYYY-MM`. */
  periodKey: string;
  /**
   * How the run started; defaults to `cron`, the fan-out. The UI sends
   * `manual`, and the delivery follow-on sends `event` — the run record has to
   * be able to say a signature started this one rather than a clock.
   */
  trigger?: "cron" | "event" | "manual";
}

const CONTENT_SWITCHED_OFF =
  "Skipped: no content service is switched on for this client. Switch one on under the client's Services tab.";

/**
 * Runs the Content Writer for the client and month in the job. Everything
 * else — enablement, policy, the run record — is `handleAgentRun`'s, so a
 * disabled writer is skipped here exactly as a disabled Sentinel is.
 *
 * Checked again here, not only where the job is sent: a job queued this
 * morning for a client whose posting was switched off at lunch must not start
 * an Opus run this afternoon.
 */
export async function handleContentDraft(deps: AgentRunDeps, job: ContentDraftJob) {
  const run: AgentRunJob = {
    agentKey: CONTENT_WRITER_KEY,
    organisationId: job.organisationId,
    trigger: job.trigger ?? "cron",
    payload: { clientId: job.clientId, periodKey: job.periodKey },
  };
  const active = await activeServicesForClient(deps.db, job.organisationId, job.clientId);
  if (!hasContentService(active)) {
    deps.logger.info(`content writer skipped for client ${job.clientId}: no content service switched on`);
    return recordSkippedRun(deps, run, CONTENT_SWITCHED_OFF);
  }
  return handleAgentRun(deps, run);
}
