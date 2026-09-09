import { upsertContentBrief } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * Writes the brief this agent drafted.
 *
 * `risk: "safe"` — and that is a considered answer, not an oversight. Nothing
 * here leaves the building: a brief is an internal note about how to write for
 * a client, read only by Shoji and by the content writer. The approvals gate
 * exists for the outward step, and that step is still where it always was —
 * `content_request_approval`, before a single post reaches an audience.
 *
 * Every field is written every time, including the empty ones. A brief that
 * merged into whatever was there would make "the agent could not find an
 * audience" indistinguishable from "the audience line somebody wrote by hand
 * survived", and the second is the one worth protecting. So the agent is told
 * to read the existing brief first and carry forward anything already good.
 */
export const contentSaveBrief = defineTool({
  name: "content_save_brief",
  description:
    "Save the client's content brief. Writes every field, so include anything from the existing brief that " +
    "should be kept. Leave a field empty only when the website and knowledge base genuinely do not answer it.",
  input: z.object({
    clientId: z.string().uuid(),
    tone: z.string().max(2000).describe("How they sound. Plain, warm, formal, blunt — and what they avoid."),
    audience: z.string().max(2000).describe("Who buys from them, in their words."),
    services: z.string().max(2000).describe("What they actually sell. Only what the site or knowledge base says."),
    offers: z.string().max(2000).describe("Anything they promote — free quotes, guarantees, finance. Empty if none."),
    area: z.string().max(2000).describe("Where they work. Towns and counties, not a radius."),
    doNotSay: z.string().max(2000).describe("Claims to avoid: prices they do not publish, services they do not offer."),
    notes: z.string().max(4000).describe("Anything else a writer needs, and what you could not establish."),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const brief = await upsertContentBrief(ctx.db, ctx.organisationId, {
      ...input,
      actorKind: "agent",
    });
    return { saved: true as const, briefId: brief.id, clientId: input.clientId };
  },
});
