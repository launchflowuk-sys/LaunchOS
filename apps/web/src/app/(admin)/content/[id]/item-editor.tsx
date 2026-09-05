import type { ContentItemDetail } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveContentItemAction } from "../actions";
import { dateToLondonInput } from "../schedule-input";

/** What each channel's body is: the placeholder and the size of the box. */
const BODY_HINT: Record<ContentItemDetail["channel"], { placeholder: string; rows: number; help: string }> = {
  facebook: {
    placeholder: "What the post says. Short, in the client's voice, no hashtag pile-ups.",
    rows: 6,
    help: "Facebook post text. Around 280 characters reads best.",
  },
  instagram: {
    placeholder: "The caption. Instagram needs an image URL as well.",
    rows: 6,
    help: "Instagram caption. An image URL is required — Instagram refuses a text-only post.",
  },
  blog: {
    placeholder: "## First heading\n\nThe article, in Markdown. 600–900 words with H2 headings publishes well.",
    rows: 18,
    help: "Markdown. Headings become H2s, paragraphs and lists carry over; the title above becomes the post title.",
  },
  gbp: {
    placeholder: "The update, as it will appear on the Google Business Profile.",
    rows: 6,
    help: "Google Business Profile update. Up to 1,500 characters.",
  },
};

/**
 * The text, image, link and date. Everything posts as one form so a slot can
 * be written and scheduled in one save. Blank clears a field; the date is a
 * London wall-clock reading whatever the browser's zone.
 */
export function ItemEditor({ item }: { item: ContentItemDetail }) {
  const hint = BODY_HINT[item.channel];
  return (
    <ActionForm
      action={saveContentItemAction}
      ariaLabel="Edit post"
      success="Saved"
      className="grid gap-4 rounded-xl border bg-card p-4"
    >
      <input type="hidden" name="itemId" value={item.id} />
      <div className="space-y-1.5">
        <Label htmlFor="item-title">Title</Label>
        <Input id="item-title" name="title" defaultValue={item.title ?? ""} maxLength={200} placeholder="A working title, or the blog post's headline" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="item-body">Text</Label>
        <Textarea
          id="item-body"
          name="body"
          defaultValue={item.body ?? ""}
          rows={hint.rows}
          maxLength={20_000}
          placeholder={hint.placeholder}
          className={item.channel === "blog" ? "font-mono text-row" : undefined}
        />
        <p className="text-meta text-muted-foreground">{hint.help}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="item-image">Image URL</Label>
          <Input id="item-image" name="imageUrl" type="url" defaultValue={item.imageUrl ?? ""} placeholder="https://…/photo.jpg" />
          <p className="text-meta text-muted-foreground">Must be public: Facebook, Instagram and WordPress fetch it themselves.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-link">Link</Label>
          <Input id="item-link" name="linkUrl" type="url" defaultValue={item.linkUrl ?? ""} placeholder="https://…" />
          <p className="text-meta text-muted-foreground">Where the post points, usually a page on the client&rsquo;s site.</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="item-scheduled">Scheduled for (UK time)</Label>
          <Input id="item-scheduled" name="scheduledFor" type="datetime-local" defaultValue={dateToLondonInput(item.scheduledFor)} />
          <p className="text-meta text-muted-foreground">Leave blank to publish as soon as it is approved.</p>
        </div>
        <div className="flex sm:justify-end">
          <Button type="submit" className="max-sm:w-full">
            Save
          </Button>
        </div>
      </div>
    </ActionForm>
  );
}
