import { InlineAlert } from "@/components/inline-alert";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ArticleDefaults = {
  title: string;
  tags: readonly string[];
  bodyMd: string;
  published: boolean;
};

export const EMPTY_ARTICLE: ArticleDefaults = { title: "", tags: [], bodyMd: "", published: false };

/**
 * The fields shared by "New article" and the edit form. A server component: the
 * only interactive parts are the Markdown editor and the published checkbox,
 * which bring their own `"use client"` boundaries.
 *
 * Ids are fixed rather than generated because exactly one article form is ever
 * rendered on a page — see `form-fields.tsx` for the generated-id variant used
 * where several forms share field names.
 */
export function ArticleFields({ defaults }: { defaults: ArticleDefaults }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="article-title">Title</Label>
          <Input id="article-title" name="title" required maxLength={200} defaultValue={defaults.title} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="article-tags">Tags</Label>
          <Input
            id="article-tags"
            name="tags"
            defaultValue={defaults.tags.join(", ")}
            placeholder="hosting, dns, wordpress"
          />
          <p className="text-meta text-muted-foreground">
            Comma separated. Tags are searched alongside the title and body.
          </p>
        </div>
      </div>

      <MarkdownEditor name="bodyMd" label="Article body" defaultValue={defaults.bodyMd} />

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Checkbox id="article-published" name="published" defaultChecked={defaults.published} />
          <Label htmlFor="article-published">Published</Label>
        </div>
        <p className="text-meta text-muted-foreground">
          Support Triage and the article search only read published articles. A draft stays visible here.
        </p>
      </div>
    </div>
  );
}

/**
 * Shown when a server action bounced back to the form with `?error=`. React
 * escapes the value, so there is no injection — but anyone can hand-craft the
 * query string, so the text is capped rather than rendering an arbitrary
 * paragraph of attacker-chosen prose inside a trusted admin alert.
 */
const MAX_ERROR_LENGTH = 120;

export function FormError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  const text = message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
  return <InlineAlert tone="danger" className="mb-4">{text}</InlineAlert>;
}
