import { z } from "zod";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { UptimeProbe, UptimeResult } from "@launchos/integrations";
import { defineTool } from "../kernel/types.js";

/**
 * Probes a site the organisation actually owns. The model supplies only a
 * site id — never a URL — so it cannot aim the probe at an arbitrary host.
 */
export const uptimeCheckSite = (probe: UptimeProbe) =>
  defineTool({
    name: "uptime_check_site",
    description:
      "Perform a live HTTP check of one of this organisation's sites, by site id, and return status, latency and any error.",
    input: z.object({ siteId: z.string().uuid() }),
    risk: "safe",
    execute: async ({ siteId }, ctx): Promise<UptimeResult | { error: string }> => {
      const [site] = await ctx.db
        .select({ primaryUrl: schema.sites.primaryUrl })
        .from(schema.sites)
        .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, ctx.organisationId)));
      if (!site) return { error: "site not found" };
      return probe.check(site.primaryUrl);
    },
  });
