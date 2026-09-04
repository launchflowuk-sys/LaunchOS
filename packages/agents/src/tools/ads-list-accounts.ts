import { z } from "zod";
import { listAdAccounts } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsListAccounts = defineTool({
  name: "ads_list_accounts",
  description: "List the organisation's active ad accounts with their client, platform and currency.",
  input: z.object({ clientId: z.string().uuid().optional() }),
  risk: "safe",
  // `clientId` is spread rather than assigned so an omitted filter stays absent
  // under exactOptionalPropertyTypes instead of becoming an explicit undefined.
  execute: async (input, ctx) =>
    listAdAccounts(ctx.db, ctx.organisationId, {
      status: "active",
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    }),
});
