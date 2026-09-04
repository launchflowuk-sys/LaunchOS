import { z } from "zod";
import { computeAccountSignals } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsGetSignals = defineTool({
  name: "ads_get_signals",
  description:
    "Compare the last 7 days of an ad account against the 7 before them. Returns spend, clicks, conversions, ROAS and CPC for both windows, the percentage deltas, and whether the account is flagged.",
  input: z.object({ adAccountId: z.string().uuid() }),
  risk: "safe",
  execute: async (input, ctx) =>
    computeAccountSignals(ctx.db, ctx.organisationId, input.adAccountId, { now: ctx.now() }),
});
