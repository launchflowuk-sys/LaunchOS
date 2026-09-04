import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "../clients/list-clients.js";

export const ListSitesInput = z.object({
  clientId: z.string().uuid().optional(),
  query: z.string().trim().max(100).optional(),
  status: z.enum(["live", "building", "paused", "archived"]).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type ListSitesInput = z.input<typeof ListSitesInput>;

export type SiteListRow = {
  id: string;
  name: string;
  primaryUrl: string;
  platform: "wordpress" | "static" | "nextjs" | "other";
  status: "live" | "building" | "paused" | "archived";
  clientId: string;
  clientName: string;
  domainCount: number;
  openIncidentCount: number;
};

export async function listSites(db: Db, organisationId: string, input: ListSitesInput = {}): Promise<SiteListRow[]> {
  const v = ListSitesInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;

  return db
    .select({
      id: schema.sites.id,
      name: schema.sites.name,
      primaryUrl: schema.sites.primaryUrl,
      platform: schema.sites.platform,
      status: schema.sites.status,
      clientId: schema.sites.clientId,
      clientName: schema.clients.name,
      domainCount: sql<number>`(select count(*)::int from ${schema.domains} where ${schema.domains.siteId} = ${schema.sites.id})`,
      openIncidentCount: sql<number>`(select count(*)::int from ${schema.incidents} where ${schema.incidents.siteId} = ${schema.sites.id} and ${schema.incidents.status} <> 'resolved')`,
    })
    .from(schema.sites)
    .innerJoin(schema.clients, eq(schema.sites.clientId, schema.clients.id))
    .where(
      and(
        eq(schema.sites.organisationId, organisationId),
        v.clientId ? eq(schema.sites.clientId, v.clientId) : undefined,
        v.status ? eq(schema.sites.status, v.status) : undefined,
        term ? or(ilike(schema.sites.name, term), ilike(schema.sites.primaryUrl, term)) : undefined,
      ),
    )
    .orderBy(asc(schema.sites.name))
    .limit(v.limit);
}

export async function getSite(db: Db, organisationId: string, siteId: string) {
  const [row] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
  return row ?? null;
}
