import { NAV_GROUPS } from "@/lib/nav";
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
  /** Screens this guide is pinned to, as sidebar hrefs. */
  routes: readonly string[];
  audiences: readonly string[];
};

export const EMPTY_ARTICLE: ArticleDefaults = {
  title: "", tags: [], bodyMd: "", published: false, routes: [], audiences: ["staff"],
};

const AUDIENCES = [
  { key: "staff", label: "Staff", hint: "The people doing the work. Write these first." },
  { key: "admin", label: "You", hint: "Owner-only detail." },
  { key: "client", label: "Clients", hint: "Shown in the client portal." },
] as const;

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

      {/* Who it is for, and where it shows up. Both matter more than the body:
          a guide nobody is shown is a guide nobody reads, and the whole point
          of pinning to a screen is that help arrives where somebody is stuck
          rather than where somebody thought to look. */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who it is for</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {AUDIENCES.map((audience) => (
            <label key={audience.key} className="flex items-start gap-2">
              <Checkbox
                name="audiences"
                value={audience.key}
                defaultChecked={defaults.audiences.includes(audience.key)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{audience.label}</span>
                <span className="block text-meta text-muted-foreground">{audience.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Which screens it helps with</legend>
        <p className="text-meta text-muted-foreground">
          The help button on those screens will show this guide. Pin it to every screen where somebody might
          need it — a guide can be on more than one.
        </p>
        <div className="max-h-72 overflow-y-auto rounded-[14px] border p-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="label-caps mb-1.5 text-muted-foreground">{group.label}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {group.items.map((item) => (
                  <label key={item.href} className="flex items-center gap-2">
                    <Checkbox name="routes" value={item.href} defaultChecked={defaults.routes.includes(item.href)} />
                    <span className="text-sm">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

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
