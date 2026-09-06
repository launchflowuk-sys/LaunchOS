import { type ContentItemListRow, listContentAssets, listContentItems } from "@launchos/core";
import type { ContentChannel } from "@launchos/db/schema";
import { ExternalLink, Newspaper } from "lucide-react";
import { AssetGrid } from "@/components/asset-grid";
import { DataList, type DataListColumn } from "@/components/data-list";
import { ImageUploadForm } from "@/components/image-upload-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PortalForm } from "@/components/portal/portal-form";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { suggestPostAction } from "./actions";

export const dynamic = "force-dynamic";

/** Where a post goes, in the client's words. */
const CHANNEL_NAME: Record<ContentChannel, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  blog: "Your website blog",
  gbp: "Google Business Profile",
};

/** "Being written" is honest about a slot that is planned but not yet approved. */
function upcomingLabel(status: ContentItemListRow["status"]): { label: string; tone: "info" | "success" | "neutral" } {
  if (status === "approved" || status === "scheduled" || status === "publishing") return { label: "Scheduled", tone: "success" };
  return { label: "Being prepared", tone: "info" };
}

function titleOf(item: ContentItemListRow): string {
  return item.title ?? (item.body ? item.body.slice(0, 80) : `${CHANNEL_NAME[item.channel]} post`);
}

/**
 * The post's name with its picture beside it. The client sees what is going
 * out, image included — the thumbnail is the fastest way to tell one post from
 * the next, and it is the only place in the portal the picture appears. There
 * is no generate button here: the images are ours to draw.
 */
function PostTitle({ item }: { item: ContentItemListRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- our own /api/assets route or a public URL; next/image needs a known host list
        <img src={item.imageUrl} alt="" loading="lazy" className="size-10 shrink-0 rounded-lg border object-cover" />
      ) : null}
      <span className="min-w-0 break-words">{titleOf(item)}</span>
    </span>
  );
}

const UPCOMING_COLUMNS: readonly DataListColumn<ContentItemListRow>[] = [
  { key: "title", header: "Post", primary: true, cell: (item) => <PostTitle item={item} /> },
  {
    key: "status",
    header: "Status",
    status: true,
    cell: (item) => {
      const { label, tone } = upcomingLabel(item.status);
      return <StatusBadge value={item.status} label={label} tone={tone} />;
    },
  },
  { key: "channel", header: "Where", cell: (item) => CHANNEL_NAME[item.channel] },
  {
    key: "when",
    header: "When",
    className: "whitespace-nowrap",
    cell: (item) => (item.scheduledFor ? formatDateTime(item.scheduledFor) : "Date to be confirmed"),
  },
];

const PUBLISHED_COLUMNS: readonly DataListColumn<ContentItemListRow>[] = [
  { key: "title", header: "Post", primary: true, cell: (item) => <PostTitle item={item} /> },
  { key: "channel", header: "Where", cell: (item) => CHANNEL_NAME[item.channel] },
  {
    key: "when",
    header: "Published",
    className: "whitespace-nowrap",
    cell: (item) => formatDate(item.publishedAt ?? item.scheduledFor),
  },
  {
    key: "view",
    header: "View",
    action: true,
    cell: (item) =>
      item.externalUrl ? (
        <a
          href={item.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1 text-primary underline underline-offset-2"
        >
          View post <ExternalLink aria-hidden strokeWidth={1.75} className="size-3.5" />
        </a>
      ) : (
        <span className="text-muted-foreground">Link to follow</span>
      ),
  },
];

export default async function PortalContentPage() {
  const session = await requireClient();
  const db = getDb();

  // Both halves are scoped by the session's client: a portal user only ever
  // sees their own posts, whatever they put in the URL.
  const [upcoming, published, photos] = await Promise.all([
    listContentItems(db, session.organisationId, {
      clientId: session.clientId,
      status: ["awaiting_approval", "approved", "scheduled", "publishing"],
      sort: "scheduled",
      limit: 100,
    }),
    listContentItems(db, session.organisationId, {
      clientId: session.clientId,
      status: ["published"],
      sort: "recent",
      limit: 100,
    }),
    listContentAssets(db, session.organisationId, { clientId: session.clientId, limit: 60 }),
  ]);

  return (
    <>
      <PageHeader
        title="Content"
        description="The posts we write and publish for you — what is coming up, what has gone out, and a place to send us your ideas."
        category="delivery"
      />

      <Section title="Coming up" description="Posts being prepared or scheduled to go out.">
        <DataList
          rows={upcoming.items}
          columns={UPCOMING_COLUMNS}
          getRowKey={(item) => item.id}
          caption="Upcoming posts"
          empty={
            <EmptyState icon={Newspaper}>
              Nothing is scheduled at the moment. Posts appear here as soon as they are planned for you.
            </EmptyState>
          }
        />
      </Section>

      <Section title="Published" description="What has gone out, newest first.">
        <DataList
          rows={published.items}
          columns={PUBLISHED_COLUMNS}
          getRowKey={(item) => item.id}
          caption="Published posts"
          empty={<EmptyState icon={Newspaper}>Nothing has been published yet. Your first posts will be listed here.</EmptyState>}
        />
      </Section>

      <Section
        title="Add photos"
        description="Upload photos of your work; posts with photos do far better. We use them on your posts — the shop, the team, a job well done."
      >
        <div className="space-y-4">
          <div className="max-w-2xl rounded-xl border bg-card p-5 sm:p-6">
            <ImageUploadForm
              endpoint="/api/portal/assets"
              idPrefix="portal-photo"
              ariaLabel="Add a photo"
              submitLabel="Add photo"
              altLabel="What is in the photo? (optional)"
              success="Thanks — the photo is in your library and we can use it on your posts."
              tall
            />
          </div>
          <AssetGrid assets={photos} empty="No photos yet. The first one you add appears here." />
        </div>
      </Section>

      <Section
        title="Suggest a post"
        description="Got news, an offer or a photo worth sharing? Tell us and we will write it up, schedule it and let you see it here."
      >
        <div className="max-w-2xl rounded-xl border bg-card p-5 sm:p-6">
          <PortalForm
            action={suggestPostAction}
            submitLabel="Send suggestion"
            ariaLabel="Suggest a post"
            success="Thanks — we have added it to your list and will write it up."
          >
            <div className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="suggest-text">What should the post say?</Label>
                <Textarea id="suggest-text" name="text" required rows={5} maxLength={4000} className="min-h-32 bg-card" />
                <p className="text-meta text-muted-foreground">A few lines is plenty. We will polish the wording.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="suggest-link">Link to include (optional)</Label>
                <Input id="suggest-link" name="linkUrl" type="url" placeholder="https://" className="h-11 bg-card text-base" />
              </div>
            </div>
          </PortalForm>
        </div>
      </Section>
    </>
  );
}
