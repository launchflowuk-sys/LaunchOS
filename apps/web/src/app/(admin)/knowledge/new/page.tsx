import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/session";
import { createArticleAction } from "../actions";
import { ArticleFields, EMPTY_ARTICLE, FormError } from "../article-fields";

export const dynamic = "force-dynamic";

export default async function NewArticlePage({ searchParams }: PageProps<"/knowledge/new">) {
  await requireAdmin();
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;

  return (
    <>
      <PageHeader
        title="New article"
        description="Write it the way you would explain it to a client. The slug is generated from the title."
        category="automation"
      />

      <FormError message={error} />

      <form action={createArticleAction} className="rounded-xl border bg-card p-4 sm:p-6">
        <ArticleFields defaults={EMPTY_ARTICLE} />
        <div className="mt-6 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button asChild variant="secondary">
            <Link href="/knowledge">Cancel</Link>
          </Button>
          <Button type="submit">Create article</Button>
        </div>
      </form>
    </>
  );
}
