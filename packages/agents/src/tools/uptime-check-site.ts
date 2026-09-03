import { z } from "zod";
import type { UptimeProbe } from "@launchos/integrations";
import { defineTool } from "../kernel/types.js";

export const uptimeCheckSite = (probe: UptimeProbe) =>
  defineTool({
    name: "uptime_check_site",
    description: "Perform a live HTTP check of a URL and return status, latency and any error.",
    input: z.object({ url: z.string().url() }),
    risk: "safe",
    execute: async ({ url }) => probe.check(url),
  });
