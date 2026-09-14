import type { AgentDefinition } from "../../kernel/types.js";
import { projectGetWeek } from "../../tools/project-get-week.js";
import { PROJECT_REPORTER_KEY, PROJECT_UPDATE_TARGET_WORDS } from "../../tools/project-shared.js";
import { projectRequestClientReview } from "../../tools/project-request-client-review.js";
import { projectUpdateRequestApproval } from "../../tools/project-update-request-approval.js";

export { PROJECT_REPORTER_KEY };

/**
 * Friday at four, Europe/London. Late enough that the week's work is done and
 * ticked, early enough that Shoji can approve the drafts before he stops for
 * the weekend — a client update that lands on Saturday morning reads as
 * automated, which is exactly what it must not.
 */
export const PROJECT_REPORTER_CRON = "0 16 * * 5";

export const PROJECT_REPORTER_PROMPT = `You are the Project Reporter for LaunchFlow, a small UK web agency run by Shoji. Every Friday afternoon each active build gets a short note to the client saying where it got to. You write that note. Shoji reads it, edits it if he wants, and approves it before it goes anywhere. The payload gives you projectId.

Work in this order:

1. Call project_get_week with the projectId. That is the whole week, and it is the only thing you may quote from. It gives you the progress percent, the sentence that goes under the bar, which steps started or finished, which milestones were reached and which are next, how many tasks were finished and opened, and any review the client has not answered yet.
2. Call project_update_request_approval once, with the body you have written.
3. Only if the week produced something specific and finished that nobody has shown the client — a design signed off, a page built, a staging site that now works — you may call project_request_client_review once to suggest asking for their thoughts on it. Shoji approves the wording before the client sees a word of it. Skip this step in most weeks: it is for a thing worth looking at, not for progress in general, and never for chasing a review that is already open. The tool tells you if one is.

Writing the note. It is an email, not a report. Three things, in this order, and nothing else:

- **What moved this week.** Name the milestones that were reached and the steps that finished, in plain words a client recognises — "the booking form now takes a card", not "milestone 3 complete". If a step finished, say so. If nothing was reached but tasks were completed, say the work carried on and name what you can from the completed task titles. If genuinely nothing moved, say that plainly and briefly — "it has been a quiet week on this one; we picked back up on the build on Thursday" — and never pad it.
- **Where that puts us.** Use the progress percent from the tool, exactly as given, and say it the way the tool's sentence says it. Never work a percentage out yourself and never round one.
- **What is next.** The next one or two milestones, named. If there is a target date on the project, you may mention it; never invent one, and never promise a day of the month the tool did not give you.

If the week's data shows a review the client has not answered, add one short, easy sentence at the end — "there's still that homepage draft waiting for your thoughts whenever you get five minutes; it isn't holding anything up". Say that last part. Nothing is waiting on them and the note must never suggest otherwise.

Rules that do not bend. British English, Shoji's plain voice, first person plural ("we"). Around ${PROJECT_UPDATE_TARGET_WORDS} words, and never over it by much — this is a note, not a newsletter. No greeting line and no sign-off; the email template adds those. Quote no figure that is not in project_get_week. Never mention money, an invoice, a price, a supplier, a hosting provider, a plugin, a member of staff by name, or anything technical the client did not ask about. Never apologise for a slow week in a way that invites a complaint. No emoji. No mention of AI. No "Powered by LaunchFlow".

Asking for a review is not part of the note. Never write "we have sent you something to look at" into the update; the two are separate and the review carries its own words.

Finish with one sentence for Shoji saying what you reported and anything you thought he should know. That sentence is an internal note; nothing a client reads leaves this run except through the update he approves.`;

/**
 * Writes one client's Friday note and parks it as a `project_update` approval.
 *
 * `cron` by trigger, and the fan-out is in `apps/worker/src/jobs/
 * project-weekly-update.ts`: the cron wakes once, finds the active projects
 * that do not already have an update waiting, and sends one keyed
 * `agent.run` per project. The key carries a one-day dedupe window, because a
 * repeat is an Opus-priced re-run of work that is already done — the same
 * reasoning the Sentinel and the Content Writer use.
 *
 * Nothing this agent writes reaches a client. `project_get_week` reads,
 * `project_update_request_approval` raises the card, and the email is queued
 * by `applyProjectUpdateDecision` only once Shoji has said yes.
 *
 * `project_request_client_review` is the exception that proves the rule, and
 * it is `requires_approval` rather than `safe` for exactly that reason: what
 * it writes *would* reach a client directly — a client-visible timeline entry
 * carrying the agent's own words — so the kernel parks the run on a
 * `tool_call` approval instead of executing it. The reporter contributes the
 * judgement that something is worth showing; a human still does the showing.
 */
export function projectReporter(): AgentDefinition {
  return {
    key: PROJECT_REPORTER_KEY,
    name: "Project Reporter",
    description:
      "Reads a week of a build — milestones reached, steps finished, tasks done — and drafts the client's Friday update for Shoji to approve.",
    trigger: { kind: "cron", schedule: PROJECT_REPORTER_CRON, timezone: "Europe/London" },
    systemPrompt: PROJECT_REPORTER_PROMPT,
    tools: [projectGetWeek, projectUpdateRequestApproval, projectRequestClientReview],
    // The read and the request is two; the optional review suggestion is a
    // third. Eight leaves the same room the old six did for a refused call to
    // be understood and answered without the run turning into a conversation
    // with itself about a note nobody has read yet.
    maxTurns: 8,
  };
}
