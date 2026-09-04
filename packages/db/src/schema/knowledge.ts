import { sql } from "drizzle-orm";
import { boolean, customType, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

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
  search: tsvector("search").generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B') || setweight(to_tsvector('english', coalesce(array_to_string_immutable(tags, ' '), '')), 'C')`,
  ),
}, (t) => [
  uniqueIndex("knowledge_articles_org_slug").on(t.organisationId, t.slug),
  index("knowledge_articles_search").using("gin", t.search),
]);
