import type { CmsProvider } from "@launchos/integrations";
import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cmsProviderFor, type CmsProviderFactory } from "../agents/integrations.js";
import { defineTool } from "../kernel/types.js";

/**
 * @param cms A provider, or a factory the tool calls with the run's own
 * organisation — the real WordPress provider looks credentials up per site and
 * per tenant, and only the tool context knows which tenant is running.
 */
export function cmsUpdateContent(cms: CmsProvider | CmsProviderFactory) {
  return defineTool({
    name: "cms_update_content",
    description: "Change one page or post's content on a client's CMS. Requires human approval.",
    input: z.object({
      siteId: z.string().uuid(),
      path: z.string().min(1).max(300),
      contentMd: z.string().min(1).max(20000),
    }),
    risk: "requires_approval",
    // The site and client come from our rows; the replacement content is the
    // thing being released, so the approver reads it in full before deciding.
    //
    // And the card says what approving will actually do. Without
    // `SECRETS_ENCRYPTION_KEY` the provider is `MockCmsProvider`, which records
    // the change and reports success, so "goes live immediately" would be a
    // lie. The adapter is read here, at describe time, for the organisation
    // that is running, so the wording is true of this deployment.
    describeApproval: async (input, ctx) => {
      const provider = cmsProviderFor(cms, ctx);
      const [site] = await ctx.db
        .select({
          name: schema.sites.name,
          primaryUrl: schema.sites.primaryUrl,
          platform: schema.sites.platform,
          clientName: schema.clients.name,
        })
        .from(schema.sites)
        .innerJoin(schema.clients, eq(schema.sites.clientId, schema.clients.id))
        .where(and(eq(schema.sites.id, input.siteId), eq(schema.sites.organisationId, ctx.organisationId)));
      if (!site) {
        return {
          title: "Change content on a site that does not exist",
          summary: `No site ${input.siteId} exists in this organisation. Approving it will fail.`,
          details: { path: input.path, newContentMd: input.contentMd },
        };
      }
      const isMock = provider.name.startsWith("mock");
      const effect = isMock
        ? `The CMS adapter wired into this deployment is the mock (\`${provider.name}\`): approving records the change in LaunchOS and audits it, but **the page is not touched** until a real CMS provider is configured.`
        : "It replaces the whole page and goes live immediately.";
      return {
        title: `Replace the content at ${input.path} on ${site.name}`,
        summary:
          `Approving overwrites the page at ${site.primaryUrl}${input.path} on ${site.name} ` +
          `(${site.clientName}, ${site.platform}) with the ${input.contentMd.length}-character draft below. ${effect}`,
        details: {
          client: site.clientName,
          site: site.name,
          page: `${site.primaryUrl}${input.path}`,
          platform: site.platform,
          // The platform recorded on the site row, and the adapter that will
          // actually be called. They differ while the adapter is a mock.
          adapter: provider.name,
          appliesToLiveSite: !isMock,
          newContentMd: input.contentMd,
        },
      };
    },
    execute: async (input, ctx) => {
      const provider = cmsProviderFor(cms, ctx);
      // The site ref is read from our own records, never from the model, so an
      // approved change can only ever touch a site we manage.
      const [site] = await ctx.db
        .select({ hostingRef: schema.sites.hostingRef })
        .from(schema.sites)
        .where(and(eq(schema.sites.id, input.siteId), eq(schema.sites.organisationId, ctx.organisationId)));
      if (!site) throw new Error(`site ${input.siteId} not found in organisation`);
      if (!site.hostingRef) throw new Error(`site ${input.siteId} has no hostingRef to update content on`);

      // `siteId` travels alongside `siteRef` because the real WordPress client
      // looks its credentials up per site, and the hosting ref is Coolify's
      // name for the container, not ours for the site.
      const result = await provider.updateContent({
        siteRef: site.hostingRef,
        siteId: input.siteId,
        path: input.path,
        contentMd: input.contentMd,
      });
      await recordAudit(ctx.db, ctx.organisationId, {
        actorKind: "agent", actorId: "support-triage", action: "site_content.updated",
        targetType: "site", targetId: input.siteId, after: { ...input, siteRef: site.hostingRef, provider: provider.name },
      });
      return result;
    },
  });
}
