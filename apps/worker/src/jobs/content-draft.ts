import { CONTENT_WRITER_KEY } from "@launchos/agents";
import { handleAgentRun, type AgentRunDeps } from "./agent-run.js";

/**
 * One writer run for one client's month. Sent by `content.plan-month` on the
 * 1st, and by "Draft with AI" on the client's content tab.
 *
 * Keyed `content-draft:<clientId>:<periodKey>` under a one-day window by the
 * cron fan-out (an Opus-priced run, the same reasoning as the Sentinel); a
 * manual send appends `:manual:<epochMs>` so an operator's "draft now" is
 * never deduped away.
 */
export interface ContentDraftJob {
  organisationId: string;
  clientId: string;
  /** `YYYY-MM`. */
  periodKey: string;
  /** How the run started; defaults to `cron`, the fan-out. The UI sends `manual`. */
  trigger?: "cron" | "manual";
}

/**
 * Runs the Content Writer for the client and month in the job. Everything
 * else — enablement, policy, the run record — is `handleAgentRun`'s, so a
 * disabled writer is skipped here exactly as a disabled Sentinel is.
 */
export async function handleContentDraft(deps: AgentRunDeps, job: ContentDraftJob) {
  return handleAgentRun(deps, {
    agentKey: CONTENT_WRITER_KEY,
    organisationId: job.organisationId,
    trigger: job.trigger ?? "cron",
    payload: { clientId: job.clientId, periodKey: job.periodKey },
  });
}
