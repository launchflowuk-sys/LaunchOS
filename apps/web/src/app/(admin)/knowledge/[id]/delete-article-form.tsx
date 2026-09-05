"use client";

import { Button } from "@/components/ui/button";
import { deleteArticleAction } from "../actions";

/**
 * A plain `<form action>` so the server action can redirect back to the list,
 * wrapped in a client component only for the confirm: deleting is one click
 * from a page that otherwise just saves text.
 */
export function DeleteArticleForm({ articleId, title }: { articleId: string; title: string }) {
  return (
    <form
      action={deleteArticleAction}
      onSubmit={(event) => {
        if (!window.confirm(`Delete “${title}”? It will stop appearing in the list and in agent searches.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="articleId" value={articleId} />
      <Button type="submit" variant="destructive" className="max-sm:w-full">
        Delete article
      </Button>
    </form>
  );
}
