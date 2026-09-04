import type { CmsProvider } from "@launchos/integrations";
import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export function cmsUpdateContent(cms: CmsProvider) {
  return defineTool({
    name: "cms_update_content",
    description: "Change one page or post's content on a client's CMS. Requires human approval.",
    input: z.object({
      siteId: z.string().uuid(),
      path: z.string().min(1).max(300),
      contentMd: z.string().min(1).max(20000),
    }),
    risk: "requires_approval",
    execute: async (input, ctx) => {
      // The site ref is read from our own records, never from the model, so an
      // approved change can only ever touch a site we manage.
      const [site] = await ctx.db
        .select({ hostingRef: schema.sites.hostingRef })
        .from(schema.sites)
        .where(and(eq(schema.sites.id, input.siteId), eq(schema.sites.organisationId, ctx.organisationId)));
      if (!site) throw new Error(`site ${input.siteId} not found in organisation`);
      if (!site.hostingRef) throw new Error(`site ${input.siteId} has no hostingRef to update content on`);

      const result = await cms.updateContent({ siteRef: site.hostingRef, path: input.path, contentMd: input.contentMd });
      await recordAudit(ctx.db, ctx.organisationId, {
        actorKind: "agent", actorId: "support-triage", action: "site_content.updated",
        targetType: "site", targetId: input.siteId, after: { ...input, siteRef: site.hostingRef, provider: cms.name },
      });
      return result;
    },
  });
}
