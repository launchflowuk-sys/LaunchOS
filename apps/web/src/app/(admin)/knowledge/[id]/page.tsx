import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { updateArticleAction } from "../actions";
import { ArticleFields, FormError } from "../article-fields";
import { DeleteArticleForm } from "./delete-article-form";

export const dynamic = "force-dynamic";

const Uuid = z.string().uuid();

export default async function ArticlePage({ params, searchParams }: PageProps<"/knowledge/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;
  const query = await searchParams;
  const error = typeof query.error === "string" ? query.error : undefined;

  // A non-uuid path segment is a 404, not a Postgres cast error.
  if (!Uuid.safeParse(id).success) notFound();

  // Read here rather than through a core service: this is a single row by id,
  // and the org + soft-delete filters are the whole of the rule.
  const [article] = await getDb()
    .select()
    .from(schema.knowledgeArticles)
    .where(
      and(
        eq(schema.knowledgeArticles.id, id),
        eq(schema.knowledgeArticles.organisationId, session.organisationId),
        isNull(schema.knowledgeArticles.deletedAt),
      ),
    );
  if (!article) notFound();

  return (
    <>
      <PageHeader
        title={article.title}
        description={`${article.slug} · updated ${formatDateTime(article.updatedAt)}`}
        category="automation"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              value={article.published ? "published" : "draft"}
              tone={article.published ? "success" : "neutral"}
            />
            <Button asChild variant="secondary" size="sm">
              <Link href="/knowledge">Back to list</Link>
            </Button>
          </div>
        }
      />

      <FormError message={error} />

      <ActionForm
        action={updateArticleAction}
        ariaLabel={`Edit ${article.title}`}
        success="Article saved"
        className="rounded-xl border bg-card p-4 sm:p-6"
      >
        <input type="hidden" name="articleId" value={article.id} />
        <ArticleFields
          defaults={{
            title: article.title,
            tags: article.tags,
            bodyMd: article.bodyMd,
            published: article.published,
          }}
        />
        <div className="mt-6 flex border-t pt-4 sm:justify-end">
          <Button type="submit" className="max-sm:w-full">
            Save article
          </Button>
        </div>
      </ActionForm>

      <Section title="Delete this article">
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            It stops appearing in the list and in agent searches. The row is kept, so an agent run that already cited
            it still resolves.
          </p>
          <DeleteArticleForm articleId={article.id} title={article.title} />
        </div>
      </Section>
    </>
  );
}
