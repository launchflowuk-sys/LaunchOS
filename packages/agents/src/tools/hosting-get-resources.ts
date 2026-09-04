import { z } from "zod";
import type { HostingProvider } from "@launchos/integrations";
import { defineTool } from "../kernel/types.js";

export const hostingGetResources = (hosting: HostingProvider) =>
  defineTool({
    name: "hosting_get_resources",
    description: "Fetch CPU, memory, disk and deployment status for a hosting resource.",
    input: z.object({ hostingRef: z.string() }),
    risk: "safe",
    execute: async ({ hostingRef }) => hosting.getResources(hostingRef),
  });
