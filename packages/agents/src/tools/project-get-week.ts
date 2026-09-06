import { projectWeekActivity, type ProjectWeekActivity } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The week the update is about, read from our own rows.
 *
 * Everything the Project Reporter is allowed to quote comes from here, and the
 * prompt forbids quoting anything that is not in it — the same contract
 * `ops_metrics_snapshot` has with the Ops Brief. `projectWeekActivity` is
 * where the filtering actually happens: internal milestones and internal task
 * titles never leave it, so the model cannot repeat one it was never shown.
 *
 * Safe: read-only, and `organisationId` is the first filter on every statement
 * behind it, so an id from another tenant returns a refusal rather than a
 * project.
 */
export const projectGetWeek = defineTool({
  name: "project_get_week",
  description:
    "What happened on one project in the last seven days: progress percent and the sentence under the bar, the phases that " +
    "started or finished, the client-visible milestones reached and the ones coming next, how many tasks were completed and " +
    "opened, and any review the client has not answered. Quote only figures and facts from this.",
  input: z.object({
    projectId: z.string().uuid().describe("The project from the run's payload."),
  }),
  risk: "safe",
  execute: async ({ projectId }, ctx): Promise<ProjectWeekActivity> =>
    projectWeekActivity(ctx.db, ctx.organisationId, { projectId, now: ctx.now() }),
});
