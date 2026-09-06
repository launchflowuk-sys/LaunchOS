import { CHANNEL_LABEL, ContentPublishPayload, getContentBrief, getContentItem, IMAGE_RENDERABLE_STATUSES } from "@launchos/core";
import { schema } from "@launchos/db";
import Link from "next/link";
import Markdown from "react-markdown";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { GenerateImage } from "../content/generate-image";
import { briefImageMode, ImageProvenance } from "../content/image-meta";

/**
 * A post asking to go out — the one approval where the thing being released
 * is the text on the card. So the text *is* the card: the exact words, the
 * image if there is one, the channel, the client and the date, read from our
 * own row rather than from whoever wrote it. "Edit" goes to the item, where
 * the text can be changed while it waits; the card re-reads it on refresh.
 *
 * The picture is read from the live item rather than from the stored payload,
 * because it can change after the approval was raised — regenerating it here
 * is the point. The post and its picture are one decision, so they are one
 * card: nobody should have to approve the words and then go somewhere else to
 * look at what goes with them.
 */
export async function ContentPublishRequest({ approval }: { approval: typeof schema.approvals.$inferSelect }) {
  const payload = ContentPublishPayload.safeParse(approval.payload);
  if (!payload.success) {
    // Never let a card with nothing to show sit next to a green Approve button.
    return (
      <InlineAlert tone="danger" title="This request cannot be shown">
        The stored post does not match what this screen expects, so approve nothing until it has been checked from the
        content page.
      </InlineAlert>
    );
  }
  const post = payload.data;
  const when = post.scheduledFor ? formatDateTime(post.scheduledFor) : "as soon as it is approved";

  // The approval row is already scoped to one organisation by the page's query,
  // so its own `organisationId` is the tenant to read the item back in.
  const db = getDb();
  const [item, brief] = await Promise.all([
    getContentItem(db, approval.organisationId, { itemId: post.itemId }),
    getContentBrief(db, approval.organisationId, { clientId: post.clientId }),
  ]);
  // Falls back to the payload's snapshot if the item has since been removed:
  // the card still shows what was asked for rather than going blank.
  const imageUrl = item?.imageUrl ?? post.imageUrl ?? null;
  const canRegenerate = item ? IMAGE_RENDERABLE_STATUSES.includes(item.status) : false;

  return (
    <>
      <InlineAlert
        tone="warning"
        title="What approving does"
        action={
          <Button asChild variant="secondary" size="sm">
            <Link href={`/content/${post.itemId}`}>Edit</Link>
          </Button>
        }
      >
        Publishes this {CHANNEL_LABEL[post.channel]} for {post.clientName} {post.scheduledFor ? `on ${when}` : when}.
        Rejecting sends it back to draft with your note.
      </InlineAlert>

      <div className="rounded-xl border bg-card p-4">
        {post.title ? <p className="mb-2 text-base font-semibold break-words">{post.title}</p> : null}
        {post.kind === "blog_post" ? (
          <div className="prose prose-sm max-w-none">
            <Markdown>{post.body}</Markdown>
          </div>
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">{post.body}</p>
        )}
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- an external, client-owned image; next/image needs a known host list
          <img src={imageUrl} alt="" className="mt-4 max-h-80 rounded-lg border object-cover" />
        ) : null}
        <ImageProvenance metadata={item?.metadata} imageUrl={imageUrl} className="mt-2" />
        {canRegenerate ? (
          <GenerateImage
            itemId={post.itemId}
            hasImage={Boolean(imageUrl)}
            clientOptedInToAi={briefImageMode(brief?.metadata) === "ai"}
            className="mt-3 border-t pt-3"
          />
        ) : null}
        {post.linkUrl ? (
          <p className="mt-3 text-meta break-all text-muted-foreground">
            Links to{" "}
            <a href={post.linkUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {post.linkUrl}
            </a>
          </p>
        ) : null}
      </div>

      <KeyValue
        columns={2}
        items={[
          {
            label: "Client",
            value: (
              <Link href={`/clients/${post.clientId}/content`} className="text-primary underline underline-offset-2">
                {post.clientName}
              </Link>
            ),
          },
          { label: "Channel", value: CHANNEL_LABEL[post.channel] },
          { label: "Scheduled for", value: post.scheduledFor ? when : "As soon as approved" },
          {
            label: "Written by",
            value: post.requestedByKind === "agent" ? "Content writer (AI)" : post.requestedByKind === "client" ? "The client" : "Staff",
          },
        ]}
      />
    </>
  );
}
