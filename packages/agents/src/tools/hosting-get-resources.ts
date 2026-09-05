import { z } from "zod";
import { isHostingRefNotFound, type HostingProvider, type HostingResources } from "@launchos/integrations";
import { defineTool } from "../kernel/types.js";

/**
 * What the Guard-Dog gets back: the resources when the ref exists, or a
 * structured "not found" it can reason over and put in its ticket.
 *
 * `hostingRef` comes from `sites.hosting_ref`, typed by a human. Against the
 * real Coolify client a wrong one is a 404 — `HostingRefNotFound` — and before
 * this branch existed that failed the whole run, so the site whose ref was
 * mistyped was exactly the site no ticket was ever filed for. Every other
 * error (auth, timeout, a 500 from Coolify) still throws: those are facts about
 * the deployment, not about the ref, and a failed run is the right report.
 */
export type HostingGetResourcesResult =
  | ({ found: true } & HostingResources)
  | { found: false; hostingRef: string; reason: string };

export const hostingGetResources = (hosting: HostingProvider) =>
  defineTool({
    name: "hosting_get_resources",
    description:
      "Fetch CPU, memory, disk and deployment status for a hosting resource. " +
      "Returns { found: false, reason } when the hosting ref is not known to the provider.",
    input: z.object({ hostingRef: z.string() }),
    risk: "safe",
    execute: async ({ hostingRef }): Promise<HostingGetResourcesResult> => {
      try {
        return { found: true, ...(await hosting.getResources(hostingRef)) };
      } catch (error) {
        if (isHostingRefNotFound(error)) return { found: false, hostingRef, reason: error.message };
        throw error;
      }
    },
  });
