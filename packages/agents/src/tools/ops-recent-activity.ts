import { recentOpsActivity } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

const Input = z.object({
  hours: z.number().int().min(1).max(24 * 14).default(24).describe("How far back to look. The morning brief uses 24."),
  limit: z.number().int().min(1).max(100).default(40).describe("At most this many timeline items, newest first."),
});

export interface OpsRecentActivityResult {
  window: { from: string; to: string; hours: number };
  timeline: { at: string; kind: string; title: string; body: string | null; link: string | null; clientName: string | null; actorKind: string }[];
  auditCounts: { action: string; count: number }[];
}

/**
 * What happened, in words: the client timelines for the window and a tally
 * of every audited action. This is how the brief can name a client, a case
 * or a post without inventing one. Safe: read-only.
 */
export const opsRecentActivity = defineTool({
  name: "ops_recent_activity",
  description:
    "The last N hours of the client timelines (what happened, which client, a link) plus a count of every audited action. " +
    "Use it to name the things behind the numbers; never mention a client or event that is not listed here.",
  input: Input,
  risk: "safe",
  execute: async (input, ctx): Promise<OpsRecentActivityResult> => {
    const result = await recentOpsActivity(ctx.db, ctx.organisationId, { hours: input.hours, limit: input.limit, now: ctx.now() });
    return {
      window: { from: result.window.from.toISOString(), to: result.window.to.toISOString(), hours: result.window.hours },
      timeline: result.timeline.map((item) => ({ ...item, at: item.at.toISOString() })),
      auditCounts: result.auditCounts,
    };
  },
});
