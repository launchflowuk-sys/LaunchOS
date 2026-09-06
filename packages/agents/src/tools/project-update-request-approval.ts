import { PROJECT_UPDATE_MAX_CHARS, ProjectUpdateRefused, requestProjectUpdateApproval } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { PROJECT_REPORTER_KEY } from "./project-shared.js";

export type ProjectUpdateRequestApprovalResult =
  | { requested: true; projectId: string; approvalId: string; subject: string }
  | { requested: false; projectId: string; reason: string };

/**
 * Puts the drafted week in front of Shoji as a `project_update` approval.
 *
 * This is the human gate on everything the reporter writes, and it is the
 * *only* gate — which is why the tool is `safe` to the kernel's policy gate
 * rather than `requires_approval`. Marking it `requires_approval` would have
 * the kernel park the run on a `tool_call` approval, and approving *that*
 * would then execute this tool, which would raise the `project_update` card —
 * two decisions for one email, with an LLM round-trip between them, and a
 * Friday queue that is twice as long as the number of projects. Instead the
 * tool executes at once, creates the `project_update` approval through core
 * (the same card a "Draft this week's update" button would raise), and the run
 * finishes. Nothing reaches the client until Shoji decides;
 * `applyProjectUpdateDecision` is what queues the email, and it sends the body
 * on the card — or Shoji's edit of it, which is how an over-cheerful sentence
 * about a quiet week gets fixed before anybody reads it.
 *
 * No `runId` is passed on purpose: an approval with a run behind it is resumed
 * by the kernel rather than applied by the web action, and this run has
 * nothing to resume — it is finished by the time anyone decides.
 *
 * Under `AGENT_POLICY=approval_all` (or the organisation's own policy) the
 * kernel gates this call like every other, so the stricter setting still
 * holds.
 */
export const projectUpdateRequestApproval = defineTool({
  name: "project_update_request_approval",
  description:
    "Send the week's update to Shoji for approval. He reads it, edits it if he wants, and approving it emails the client. " +
    "Call once, at the end of the run, after project_get_week. " +
    "Returns { requested: false, reason } if an update is already waiting or the client has no email address.",
  input: z.object({
    projectId: z.string().uuid().describe("The project from the run's payload."),
    subject: z.string().trim().min(1).max(200).optional()
      .describe("The email subject. Leave it out for the default, which names the project."),
    body: z.string().trim().min(1).max(PROJECT_UPDATE_MAX_CHARS)
      .describe("The whole email, exactly as the client will read it. Plain text, no greeting line of your own."),
    periodStart: z.string().datetime().describe("The window's start, from project_get_week's window.from."),
    periodEnd: z.string().datetime().describe("The window's end, from project_get_week's window.to."),
    progressPercent: z.number().int().min(0).max(100)
      .describe("From project_get_week's progress.percent. Do not work it out yourself."),
  }),
  risk: "safe",
  execute: async (input, ctx): Promise<ProjectUpdateRequestApprovalResult> => {
    try {
      const { approval, payload } = await requestProjectUpdateApproval(ctx.db, ctx.organisationId, {
        projectId: input.projectId,
        ...(input.subject ? { subject: input.subject } : {}),
        body: input.body,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        progressPercent: input.progressPercent,
        actorKind: "agent",
        actorId: PROJECT_REPORTER_KEY,
      });
      return { requested: true, projectId: input.projectId, approvalId: approval.id, subject: payload.subject };
    } catch (error) {
      if (error instanceof ProjectUpdateRefused) {
        return { requested: false, projectId: input.projectId, reason: error.message };
      }
      throw error;
    }
  },
});
