import { listPackages } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/** Whole pounds, or pounds and pence when there are pence: "£149" / "£149.50". */
export function poundsFromPence(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/**
 * The packages LaunchFlow sells, active only, with the monthly price — so a
 * suggested package is always one that exists, at the price it actually
 * carries. The model never quotes a figure that is not on this list.
 */
export const packagesList = defineTool({
  name: "packages_list",
  description: "List the active packages with slug, name, what they include and the monthly price. Suggest one by its slug; quote its price exactly.",
  input: z.object({}),
  risk: "safe",
  execute: async (_input, ctx) => {
    const rows = await listPackages(ctx.db, ctx.organisationId, { activeOnly: true });
    return {
      packages: rows.map((p) => ({
        slug: p.slug, name: p.name, description: p.description,
        monthlyPricePence: p.monthlyPricePence, monthlyPrice: `${poundsFromPence(p.monthlyPricePence)}/month`,
        setupPricePence: p.setupPricePence, includes: p.includes,
      })),
    };
  },
});
