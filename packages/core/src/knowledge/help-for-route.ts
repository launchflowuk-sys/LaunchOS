import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { KnowledgeAudience } from "@launchos/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

/**
 * The help for the screen somebody is standing on.
 *
 * The knowledge base had one reader and it was the Support Triage agent. This
 * is the other half: a person, employed to do the work, who should not have to
 * ask how — and who cannot be relied upon to go and find a manual, because if
 * they knew what to look up they would not be stuck.
 *
 * So help is attached to **screens**, not topics. Nobody can predict where an
 * individual gets stuck; what can be arranged is that wherever they are, the
 * help for that place is one click away, and that anywhere with nothing written
 * shows up on a list of gaps instead of quietly having nothing.
 */

export interface HelpArticle {
  id: string;
  title: string;
  slug: string;
  bodyMd: string;
  audiences: readonly KnowledgeAudience[];
}

/**
 * Published articles pinned to `route`, for a reader of this kind.
 *
 * Unpublished articles never appear: a half-written guide is worse than none,
 * because somebody will follow it. Ordering is by title so the same screen
 * lists its guides in the same order every time.
 */
export async function helpForRoute(
  db: Db,
  organisationId: string,
  route: string,
  audience: KnowledgeAudience,
): Promise<HelpArticle[]> {
  return db
    .select({
      id: schema.knowledgeArticles.id,
      title: schema.knowledgeArticles.title,
      slug: schema.knowledgeArticles.slug,
      bodyMd: schema.knowledgeArticles.bodyMd,
      audiences: schema.knowledgeArticles.audiences,
    })
    .from(schema.knowledgeArticles)
    .where(
      and(
        eq(schema.knowledgeArticles.organisationId, organisationId),
        eq(schema.knowledgeArticles.published, true),
        sql`${route} = any(${schema.knowledgeArticles.routes})`,
        sql`${audience} = any(${schema.knowledgeArticles.audiences})`,
      ),
    )
    .orderBy(asc(schema.knowledgeArticles.title));
}

export interface RouteCoverage {
  route: string;
  /** How many published guides that screen has, per audience. */
  admin: number;
  staff: number;
  client: number;
  total: number;
}

/**
 * How many published guides each screen has.
 *
 * The counterpart to `helpForRoute`, and the reason this feature can be
 * finished rather than perpetually half-done: coverage is a number. A screen
 * with no staff guide is a gap somebody can be pointed at, not an absence
 * nobody notices until an employee is stuck on a Friday afternoon.
 *
 * Takes the routes to report on rather than reading them from the articles,
 * because the interesting rows are the ones with **nothing** — which by
 * definition no article mentions.
 */
export async function routeCoverage(
  db: Db,
  organisationId: string,
  routes: readonly string[],
): Promise<RouteCoverage[]> {
  if (routes.length === 0) return [];

  const rows = await db
    .select({
      routes: schema.knowledgeArticles.routes,
      audiences: schema.knowledgeArticles.audiences,
    })
    .from(schema.knowledgeArticles)
    .where(
      and(
        eq(schema.knowledgeArticles.organisationId, organisationId),
        eq(schema.knowledgeArticles.published, true),
      ),
    );

  const empty = (route: string): RouteCoverage => ({ route, admin: 0, staff: 0, client: 0, total: 0 });
  const byRoute = new Map(routes.map((route) => [route, empty(route)]));

  for (const article of rows) {
    for (const route of article.routes) {
      const entry = byRoute.get(route);
      if (!entry) continue;
      entry.total += 1;
      for (const audience of article.audiences) entry[audience] += 1;
    }
  }

  return routes.map((route) => byRoute.get(route) ?? empty(route));
}
