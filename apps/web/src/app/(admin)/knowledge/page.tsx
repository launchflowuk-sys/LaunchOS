import { listKnowledgeArticles, searchKnowledge } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
        actions={
          <Button asChild>
            <Link href="/knowledge/new">New article</Link>
          </Button>
        }
      />

      <FormError message={error} />

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/knowledge">
        <div className="space-y-1.5">
          <label htmlFor="q" className="block text-xs font-medium text-neutral-500">
            Search articles
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Title, body or tag"
            className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
          />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {query ? (
          <Link href="/knowledge" className="px-2 py-2 text-sm text-neutral-500 hover:text-neutral-900">
            Clear
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState>
          {query
            ? "Nothing published matches that. Search covers published articles only, so a draft will not appear here."
            : "No articles yet. Support Triage searches this, so the first five you write pay for themselves."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Published</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/knowledge/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.title}
                    </Link>
                    {row.excerpt ? <span className="block max-w-md text-xs text-neutral-400">{row.excerpt}</span> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-neutral-500">{row.slug}</TableCell>
                  <TableCell className="text-neutral-600">{row.tags.length > 0 ? row.tags.join(", ") : "—"}</TableCell>
                  <TableCell>
                    <StatusBadge value={row.published ? "published" : "draft"} tone={row.published ? "success" : "neutral"} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(row.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
