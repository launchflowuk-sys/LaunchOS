import { listKnowledgeArticles, searchKnowledge } from "@launchos/core";
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Toolbar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { FormError } from "./article-fields";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  title: string;
  slug: string;
  tags: readonly string[];
  published: boolean;
  updatedAt: Date;
  excerpt?: string;
};

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "title",
    header: "Title",
    primary: true,
    cell: (row) => (
      <span className="block min-w-0">
        <Link href={`/knowledge/${row.id}`} className="underline-offset-2 hover:underline">
          {row.title}
        </Link>
        {row.excerpt ? (
          <span className="mt-0.5 block max-w-prose text-meta font-normal text-muted-foreground">{row.excerpt}</span>
        ) : null}
      </span>
    ),
  },
  {
    key: "published",
    header: "Published",
    status: true,
    cell: (row) => (
      <StatusBadge value={row.published ? "published" : "draft"} tone={row.published ? "success" : "neutral"} />
    ),
  },
  {
    key: "slug",
    header: "Slug",
    className: "font-mono text-meta",
    cell: (row) => row.slug,
  },
  { key: "tags", header: "Tags", cell: (row) => (row.tags.length > 0 ? row.tags.join(", ") : "—") },
  {
    key: "updated",
    header: "Updated",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.updatedAt),
  },
];

/**
 * Search runs through the same `searchKnowledge` the Support Triage agent uses,
 * so what Shoji finds here is exactly what the agent can find. It ranks
 * published articles only, so the ranked ids are re-joined to the full listing
 * to keep one table shape and one set of columns.
 */
async function rowsFor(organisationId: string, query: string | undefined): Promise<Row[]> {
  const db = getDb();
  const articles = await listKnowledgeArticles(db, organisationId, { includeUnpublished: true });
  if (!query) return articles;

  const byId = new Map(articles.map((article) => [article.id, article]));
  const hits = await searchKnowledge(db, organisationId, query, 20);
  return hits.flatMap((hit) => {
    const article = byId.get(hit.id);
    // `ts_headline` wraps the matched words in <b>…</b>. React would render
    // those as visible text, so they are stripped rather than trusted as HTML.
    return article ? [{ ...article, excerpt: hit.excerpt.replaceAll(/<\/?b>/g, "") }] : [];
  });
}

export default async function KnowledgePage({ searchParams }: PageProps<"/knowledge">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" && params.q.trim().length > 0 ? params.q.trim() : undefined;
  const error = typeof params.error === "string" ? params.error : undefined;

  const rows = await rowsFor(session.organisationId, query);

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        description="What Support Triage reads before it drafts a reply, and what the team reads before it fixes the same thing twice."
        category="automation"
        actions={
          <Button asChild>
            <Link href="/knowledge/new">New article</Link>
          </Button>
        }
      />

      <FormError message={error} />

      <form action="/knowledge">
        <Toolbar>
          <ToolbarField label="Search articles" htmlFor="q" className="sm:w-80">
            <Input id="q" name="q" defaultValue={query ?? ""} placeholder="Title, body or tag" />
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {query ? (
              <Button asChild variant="ghost">
                <Link href="/knowledge">Clear</Link>
              </Button>
            ) : null}
          </ToolbarActions>
        </Toolbar>
      </form>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Knowledge articles"
        empty={
          <EmptyState
            icon={BookOpen}
            action={
              query ? undefined : (
                <Button asChild>
                  <Link href="/knowledge/new">New article</Link>
                </Button>
              )
            }
          >
            {query
              ? "Nothing published matches that. Search covers published articles only, so a draft will not appear here."
              : "No articles yet. Support Triage searches this, so the first five you write pay for themselves."}
          </EmptyState>
        }
      />
    </>
  );
}
