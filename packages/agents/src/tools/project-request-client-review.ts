import { ClientReviewRefused, ProjectRefused, requestClientReview } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { PROJECT_REPORTER_KEY } from "./project-shared.js";

export type ProjectRequestClientReviewResult =
  | { requested: true; projectId: string; approvalId: string; about: string }
  | { requested: false; projectId: string; reason: string };

/**
 * Asks the client to look at something, on the reporter's suggestion.
 *
 * **`requires_approval`, unlike `project_update_request_approval` beside it** —
 * and the contrast is the whole reason this comment is long.
 *
 * That tool is `safe` because what it produces *is* a human gate: it writes a
 * `project_update` card, nothing leaves the building, and Shoji reads the email
 * before anybody else does. Marking it `requires_approval` would mean two
 * decisions for one email.
 *
 * This one is the opposite shape. `requestClientReview` writes the card **and**
 * a client-visible timeline entry — "Your thoughts, when you have a minute:
 * the prices page" — carrying the agent's own words, which the client meets in
 * their portal and in the Friday update. There is no second gate behind it,
 * because for a human raising a review there does not need to be: the person
 * asking is the person accountable for the asking. An agent is not, so the
 * kernel parks the run on a `tool_call` approval and Shoji sees the note before
 * the client does. CLAUDE.md rule 2: nothing goes outward on an agent's own
 * authority.
 *
 * The judgement is genuinely worth having from an agent — the reporter has just
 * read the week and knows a design milestone landed on Tuesday that nobody has
 * shown anybody. But "we think you should see this" in a voice the client reads
 * as ours is exactly the sentence that should cost a human tap.
 *
 * No links are accepted. A staging URL is a fact about infrastructure that the
 * reporter has no reliable way to know, and an agent guessing one would put a
 * dead address in front of a client. Shoji adds links on the panel; the agent
 * contributes the note and the timing.
 */
export const projectRequestClientReview = defineTool({
  name: "project_request_client_review",
  description:
    "Suggest asking the client to look at something on this project — usually a milestone that has just been reached. " +
    "Shoji approves the wording before the client sees it. A review never blocks the build. " +
    "Only call this when there is something specific and finished to look at; never to chase a client, and never twice " +
    "about the same thing. Returns { requested: false, reason } if one is already open for it.",
  input: z.object({
    projectId: z.string().uuid().describe("The project from the run's payload."),
    milestoneId: z.string().uuid().optional()
      .describe("The milestone this is about, from project_get_week. Leave it out only if it concerns the whole build."),
    note: z.string().trim().min(1).max(1200)
      .describe(
        "What to ask them, written to the client in plain words, as the client will read it. " +
        "Name the one thing you want their eye on. No greeting, no sign-off, no deadline — the work is not waiting on them.",
      ),
  }),
  risk: "requires_approval",
  execute: async (input, ctx): Promise<ProjectRequestClientReviewResult> => {
    try {
      const { approval, payload } = await requestClientReview(ctx.db, ctx.organisationId, {
        projectId: input.projectId,
        ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
        note: input.note,
        links: [],
        screenshots: [],
        actorKind: "agent",
        actorId: PROJECT_REPORTER_KEY,
      });
      return {
        requested: true,
        projectId: input.projectId,
        approvalId: approval.id,
        about: payload.milestoneTitle ?? payload.projectName,
      };
    } catch (error) {
      // "Already asked" and "no such milestone" are both answers the model can
      // act on — move on, or pick a milestone that exists. Anything else is a
      // fault and belongs on the run as one.
      if (error instanceof ClientReviewRefused || error instanceof ProjectRefused) {
        return { requested: false, projectId: input.projectId, reason: error.message };
      }
      throw error;
    }
  },
});
