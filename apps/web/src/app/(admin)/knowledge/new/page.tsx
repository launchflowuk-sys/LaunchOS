import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { helpRouteLabel } from "@/lib/help-routes";
import { requireAdmin } from "@/lib/session";
import { createArticleAction } from "../actions";
import { ArticleFields, EMPTY_ARTICLE, FormError } from "../article-fields";

export const dynamic = "force-dynamic";

export default async function NewArticlePage({ searchParams }: PageProps<"/knowledge/new">) {
  await requireAdmin();
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  // Arrived from the help panel or the coverage list: the screen that had
  // nothing is already ticked, so writing the guide is one less decision.
  const route = typeof params.route === "string" ? params.route : undefined;
  const defaults = route
    ? { ...EMPTY_ARTICLE, routes: [route] as readonly string[] }
    : EMPTY_ARTICLE;

  return (
    <>
      <PageHeader
        title="New article"
        description={
          route
            ? `Pinned to ${helpRouteLabel(route)}. Write it the way you would explain it to somebody standing there.`
            : "Write it as steps somebody can follow without asking. The slug comes from the title."
        }
        category="automation"
      />

      <FormError message={error} />

      <form action={createArticleAction} className="rounded-[20px] border bg-card p-5 sm:p-7">
        <ArticleFields defaults={defaults} />
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
