import { MarkdownEditor } from "@/components/markdown-editor";

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

export type ArticleDefaults = {
  title: string;
  tags: readonly string[];
  bodyMd: string;
  published: boolean;
};

export const EMPTY_ARTICLE: ArticleDefaults = { title: "", tags: [], bodyMd: "", published: false };

/**
 * The fields shared by "New article" and the edit form. A server component: the
 * only interactive part is the Markdown editor, which brings its own
 * `"use client"` boundary.
 *
 * Ids are fixed rather than generated because exactly one article form is ever
 * rendered on a page — see `form-fields.tsx` for the generated-id variant used
 * where several forms share field names.
 */
export function ArticleFields({ defaults }: { defaults: ArticleDefaults }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="article-title" className="block text-sm font-medium text-neutral-700">
            Title
          </label>
          <input id="article-title" name="title" required maxLength={200} defaultValue={defaults.title} className={CONTROL} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="article-tags" className="block text-sm font-medium text-neutral-700">
            Tags
          </label>
          <input
            id="article-tags"
            name="tags"
            defaultValue={defaults.tags.join(", ")}
            placeholder="hosting, dns, wordpress"
            className={CONTROL}
          />
          <p className="text-xs text-neutral-400">Comma separated. Tags are searched alongside the title and body.</p>
        </div>
      </div>

      <MarkdownEditor name="bodyMd" label="Article body" defaultValue={defaults.bodyMd} />

      <label htmlFor="article-published" className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          id="article-published"
          type="checkbox"
          name="published"
          defaultChecked={defaults.published}
          className="size-4 rounded border-neutral-300"
        />
        Published
      </label>
      <p className="-mt-2 text-xs text-neutral-400">
        Support Triage and the article search only read published articles. A draft stays visible here.
      </p>
    </div>
  );
}

/** Shown when a server action bounced back to the form with `?error=`. */
export function FormError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}
