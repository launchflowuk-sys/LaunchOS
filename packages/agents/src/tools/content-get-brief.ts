import { getContentBrief, listContentChannels } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The client's voice and the facts the writer may use, all from our own rows:
 * the brief, the client record, its live sites (for links) and which channels
 * are connected. Nothing here is the model's; a missing brief comes back as
 * `null` so the prompt can refuse to invent one.
 */
export const contentGetBrief = defineTool({
  name: "content_get_brief",
  description:
    "Read the client's content brief (tone, audience, services, offers, area, things never to say), the client's " +
    "name and website, its sites, and which publishing channels are connected. Call this first. " +
    "A null brief means nobody has written one yet.",
  input: z.object({ clientId: z.string().uuid() }),
  risk: "safe",
  execute: async ({ clientId }, ctx) => {
    const [client] = await ctx.db
      .select({
        id: schema.clients.id,
        name: schema.clients.name,
        tradingName: schema.clients.tradingName,
        websiteUrl: schema.clients.websiteUrl,
        city: schema.clients.city,
        industry: schema.clients.industry,
      })
      .from(schema.clients)
      .where(and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.organisationId, ctx.organisationId),
        isNull(schema.clients.deletedAt),
      ));
    if (!client) return { found: false as const, clientId, reason: "No such client in this organisation." };

    const [brief, channels, sites] = await Promise.all([
      getContentBrief(ctx.db, ctx.organisationId, { clientId }),
      listContentChannels(ctx.db, ctx.organisationId, { clientId }),
      ctx.db
        .select({ id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl, status: schema.sites.status })
        .from(schema.sites)
        .where(and(
          eq(schema.sites.clientId, clientId),
          eq(schema.sites.organisationId, ctx.organisationId),
          isNull(schema.sites.deletedAt),
        )),
    ]);

    return {
      found: true as const,
      client,
      brief: brief
        ? {
            tone: brief.tone,
            audience: brief.audience,
            services: brief.services,
            offers: brief.offers,
            area: brief.area,
            doNotSay: brief.doNotSay,
            notes: brief.notes,
          }
        : null,
      sites,
      channels: channels.map((c) => ({ channel: c.channel, displayName: c.displayName, enabled: c.enabled })),
    };
  },
});
