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
      />

      <FormError message={error} />

      <form action={createArticleAction} className="rounded-lg border border-neutral-200 bg-white p-4">
        <ArticleFields defaults={EMPTY_ARTICLE} />
        <div className="mt-4 flex justify-end gap-2">
          <Button asChild variant="outline">
            <Link href="/knowledge">Cancel</Link>
          </Button>
          <Button type="submit">Create article</Button>
        </div>
      </form>
    </>
  );
}
