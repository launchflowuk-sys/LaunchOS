import type { Db } from "@launchos/db";
import { sql } from "drizzle-orm";

export interface KnowledgeHit {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  tags: string[];
  rank: number;
}

export const KNOWLEDGE_SEARCH_LIMIT = 5;

/**
 * `plainto_tsquery` treats the query as plain words, so nothing a client (or a
 * model) types can inject tsquery operators. A query with no lexemes matches
 * nothing rather than erroring, so the caller gets `[]`.
 */
export async function searchKnowledge(
  db: Db,
  organisationId: string,
  query: string,
  limit = KNOWLEDGE_SEARCH_LIMIT,
): Promise<KnowledgeHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const rows = await db.execute<{ id: string; title: string; slug: string; excerpt: string; tags: string[]; rank: number }>(sql`
    select
      a.id,
      a.title,
      a.slug,
      ts_headline('english', a.body_md, q, 'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=1') as excerpt,
      a.tags,
      ts_rank(a.search, q) as rank
    from knowledge_articles a, plainto_tsquery('english', ${trimmed}) q
    where a.organisation_id = ${organisationId}
      and a.deleted_at is null
      and a.published = true
      and a.search @@ q
    order by rank desc, a.title asc
    limit ${Math.max(1, Math.min(limit, 20))}
  `);
  return rows.map((r) => ({ ...r, rank: Number(r.rank) }));
}
