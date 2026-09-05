import { createOpsBrief } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { OPS_BRIEF_HARD_MAX_WORDS, OPS_BRIEF_KEY, OPS_BRIEF_MAX_WORDS, londonDateKey, wordCount } from "./ops-shared.js";

const Highlight = z.object({
  label: z.string().trim().min(1).max(200).describe("One line: what needs the owner, e.g. 'Approve 2 posts for Grays CabLine'."),
  detail: z.string().trim().max(500).optional().describe("A sentence of context, if the label needs one."),
  link: z.string().trim().max(500).optional().describe("Where to go: an admin path such as /approvals, /tasks, /cases, /incidents, /invoices, /content, /agents/runs."),
});

const Input = z.object({
  bodyMd: z.string().trim().min(1).max(20_000).describe(
    `The brief in Markdown, at most ${OPS_BRIEF_MAX_WORDS} words, with the sections "## Yesterday", "## Needs you today", "## Team" and "## Money".`,
  ),
  highlights: z.array(Highlight).max(20).default([]).describe("The 'Needs you today' bullets as data, so the dashboard card can render them with links."),
});

export type OpsSaveBriefResult =
  | { saved: true; briefId: string; briefDate: string; words: number; replaced: boolean }
  | { saved: false; reason: string };

/**
 * Writes the brief for today's London date. Safe: it is a record for the
 * owner, and nothing here leaves the building — the worker rings the bell and
 * sends the owner's email after the run, off this row.
 *
 * The length rule is enforced here as data rather than left to the prompt,
 * with some tolerance: a brief a little over reads fine, one far over has
 * ignored the rule and is sent back to be trimmed instead of failing the run.
 */
export const opsSaveBrief = defineTool({
  name: "ops_save_brief",
  description:
    `Save today's brief. Returns { saved: false, reason } when the body is over ${OPS_BRIEF_HARD_MAX_WORDS} words so you can ` +
    "trim it and save again. Call it once, at the end.",
  input: Input,
  risk: "safe",
  execute: async (input, ctx): Promise<OpsSaveBriefResult> => {
    const words = wordCount(input.bodyMd);
    if (words > OPS_BRIEF_HARD_MAX_WORDS) {
      return { saved: false, reason: `The brief is ${words} words; keep it to ${OPS_BRIEF_MAX_WORDS}. Cut detail, not sections.` };
    }
    const { brief, replaced } = await createOpsBrief(ctx.db, ctx.organisationId, {
      briefDate: londonDateKey(ctx.now()),
      bodyMd: input.bodyMd,
      highlights: input.highlights,
      agentRunId: ctx.runId,
      actorKind: "agent",
      actorId: OPS_BRIEF_KEY,
    });
    return { saved: true, briefId: brief.id, briefDate: brief.briefDate, words, replaced };
  },
});
