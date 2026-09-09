import { sql } from "drizzle-orm";
import { boolean, customType, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

/**
 * Who an article is for. `staff` is the reason this exists: somebody employed
 * to do the work, who should not have to ask how, and who may not be
 * comfortable with software.
 */
export type KnowledgeAudience = "admin" | "staff" | "client";
export const KNOWLEDGE_AUDIENCES: readonly KnowledgeAudience[] = ["admin", "staff", "client"];

export const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => "tsvector" });

/**
 * `search` is a stored generated column: every expression in it must be
 * IMMUTABLE. `to_tsvector(regconfig, text)` with a literal config and
 * `setweight` both are, but plain `array_to_string(anyarray, text)` is only
 * STABLE in Postgres (see pg_proc.provolatile) — Postgres refuses it inside
 * a generated column ("generation expression is not immutable"). The
 * `array_to_string_immutable` SQL wrapper created in the 0005 migration
 * pins that same (safe, locale-independent for text[]) behaviour as
 * IMMUTABLE so it can be used here.
 */
export const knowledgeArticles = pgTable("knowledge_articles", {
  ...tenantColumns(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  bodyMd: text("body_md").notNull(),
  tags: text("tags").array().$type<string[]>().default([]).notNull(),
  published: boolean("published").default(false).notNull(),
  /**
   * Who this is written for. Empty means the agent's reference material and
   * nobody's reading list — which is what every article was before this column,
   * because the knowledge base had exactly one reader and it was Support
   * Triage.
   *
   * One article set with an audience rather than three tables: the same
   * sentence about how a support address works is often the right sentence for
   * a staff member and a client, and three editors guarantees two of them go
   * stale.
   */
  audiences: text("audiences").array().$type<KnowledgeAudience[]>().default([]).notNull(),
  /**
   * The screens this article helps with, as `NAV_GROUPS` hrefs — `/clients`,
   * `/approvals`.
   *
   * The point of the column, and of the whole feature: help has to arrive where
   * somebody is stuck, and neither Shoji nor anyone else can predict where that
   * is. Attaching articles to screens instead of topics makes coverage a
   * property that can be *counted* — every screen either has a guide or shows
   * up on the gaps list — rather than something someone has to remember.
   */
  routes: text("routes").array().$type<string[]>().default([]).notNull(),
  search: tsvector("search").generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B') || setweight(to_tsvector('english', coalesce(array_to_string_immutable(tags, ' '), '')), 'C')`,
  ),
}, (t) => [
  uniqueIndex("knowledge_articles_org_slug").on(t.organisationId, t.slug),
  index("knowledge_articles_search").using("gin", t.search),
]);
