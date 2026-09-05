import {
  CANCELLABLE_STATUSES, CHANNEL_LABEL, EDITABLE_STATUSES, getContentItem, MAX_CONTENT_PUBLISH_ATTEMPTS, monthName,
} from "@launchos/core";
import { schema } from "@launchos/db";
import type { ContentStatus } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { cancelContentItemAction, requestContentApprovalAction } from "../actions";
import { ChannelLabel, ContentStatusBadge, KIND_LABEL } from "../presentation";
import { ItemEditor } from "./item-editor";

export const dynamic = "force-dynamic";

/** Statuses an edit returns to `draft` from — core's `updateContentItem` rule, mirrored for the form. */
const REVISABLE_STATUSES: readonly ContentStatus[] = ["rejected", "failed"];

/** What the status means for the person looking at it, in one line. */
const STATUS_NOTE: Record<ContentStatus, string> = {
  draft: "Not sent anywhere yet. Edit it, then send it for approval.",
  awaiting_approval: "Parked in Approvals. Approving it there is what publishes it; you can still edit the text meanwhile.",
  approved: "Approved. The publish sweep sends it at the scheduled time, or straight away if that time has passed.",
  scheduled: "Approved and scheduled. The publish sweep sends it at the scheduled time.",
  publishing: "Being sent right now.",
  published: "Live. The link below goes to the post.",
  failed: "Publishing failed three times. Fix what went wrong and save to return it to draft.",
  rejected: "Rejected in Approvals. Editing it returns it to draft for another go.",
  cancelled: "Cancelled. Nothing more happens to this slot.",
};

export default async function ContentItemPage({ params }: PageProps<"/content/[id]">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  // getContentItem filters on the organisation, so another org's id is a 404.
  const item = await getContentItem(db, session.organisationId, { itemId: id });
  if (!item) notFound();

  const [approval] = item.approvalId
    ? await db
        .select({
          status: schema.approvals.status,
          decisionNote: schema.approvals.decisionNote,
          decidedAt: schema.approvals.decidedAt,
        })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.id, item.approvalId), eq(schema.approvals.organisationId, session.organisationId)))
    : [];

  const isEditable = EDITABLE_STATUSES.includes(item.status) || REVISABLE_STATUSES.includes(item.status);
  const isCancellable = CANCELLABLE_STATUSES.includes(item.status);
  const attempts = typeof item.metadata.publishAttempts === "number" ? item.metadata.publishAttempts : 0;
  const isSuggested = item.source === "client";

  return (
    <>
      <PageHeader
        title={item.title ?? `${CHANNEL_LABEL[item.channel]} slot`}
        description={`${KIND_LABEL[item.kind]} · ${item.clientName} · ${monthName(item.periodKey)}`}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">
            <ContentStatusBadge status={item.status} />
            {item.status === "draft" ? (
              <ActionForm action={requestContentApprovalAction} ariaLabel="Send for approval" success="Sent for approval">
                <input type="hidden" name="itemId" value={item.id} />
                <Button type="submit" className="max-sm:w-full">
                  Send for approval
                </Button>
              </ActionForm>
            ) : null}
            {isCancellable ? (
              <ActionForm action={cancelContentItemAction} ariaLabel="Cancel post" success="Post cancelled">
                <input type="hidden" name="itemId" value={item.id} />
                <Button type="submit" variant="destructive-quiet" className="max-sm:w-full">
                  Cancel
                </Button>
              </ActionForm>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {item.status === "failed" && item.lastError ? (
            <InlineAlert tone="danger" title="Publishing failed" className="mb-6">
              <p>
                {item.lastError} — {attempts} of {MAX_CONTENT_PUBLISH_ATTEMPTS} attempts used.
              </p>
            </InlineAlert>
          ) : item.lastError ? (
            <InlineAlert tone="warning" title="Last attempt failed; it will be retried" className="mb-6">
              <p>
                {item.lastError} — {attempts} of {MAX_CONTENT_PUBLISH_ATTEMPTS} attempts used.
              </p>
            </InlineAlert>
          ) : null}

          {item.status === "rejected" && approval ? (
            <InlineAlert tone="warning" title="Rejected in Approvals" className="mb-6">
              <p>
                {approval.decisionNote ? `"${approval.decisionNote}"` : "No note was left."} Decided{" "}
                {formatDateTime(approval.decidedAt)}. Edit the text below and it returns to draft.
              </p>
            </InlineAlert>
          ) : null}

          {isSuggested && item.status === "draft" ? (
            <InlineAlert tone="info" title="Suggested by the client" className="mb-6">
              <p>This came in from the client portal. Tidy it up, pick the channel it suits, and send it for approval.</p>
            </InlineAlert>
          ) : null}

          {isEditable ? (
            <Section title="Post" description={STATUS_NOTE[item.status]}>
              <ItemEditor item={item} />
            </Section>
          ) : (
            <Section title="Post" description={STATUS_NOTE[item.status]}>
              <div className="rounded-xl border bg-card p-4">
                {item.body ? (
                  item.channel === "blog" ? (
                    <div className="prose prose-sm max-w-none">
                      <Markdown>{item.body}</Markdown>
                    </div>
                  ) : (
                    <p className="text-sm break-words whitespace-pre-wrap">{item.body}</p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">No text.</p>
                )}
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an external, client-owned image; next/image needs a known host list
                  <img src={item.imageUrl} alt="" className="mt-4 max-h-80 rounded-lg border object-cover" />
                ) : null}
              </div>
            </Section>
          )}
        </div>

        <div className="min-w-0">
          <Section title="Details">
            <div className="rounded-xl border bg-card p-4">
              <KeyValue
                items={[
                  {
                    label: "Client",
                    value: (
                      <Link href={`/clients/${item.clientId}/content`} className="text-primary underline underline-offset-2">
                        {item.clientName}
                      </Link>
                    ),
                  },
                  { label: "Channel", value: <ChannelLabel channel={item.channel} /> },
                  { label: "Scheduled for", value: item.scheduledFor ? formatDateTime(item.scheduledFor) : "As soon as approved" },
                  { label: "Written by", value: item.source === "agent" ? "Content writer (AI)" : item.source === "client" ? "The client" : "Staff" },
                  { label: "Created", value: formatDateTime(item.createdAt) },
                  { label: "Last changed", value: formatDateTime(item.updatedAt) },
                ]}
              />
            </div>
          </Section>

          <Section title="Publishing">
            <div className="rounded-xl border bg-card p-4">
              <KeyValue
                items={[
                  {
                    label: "Live post",
                    value: item.externalUrl ? (
                      <a
                        href={item.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                      >
                        View post <ExternalLink aria-hidden strokeWidth={1.75} className="size-3.5" />
                      </a>
                    ) : (
                      "Not published yet"
                    ),
                  },
                  { label: "Published", value: formatDateTime(item.publishedAt) },
                  { label: "Attempts", value: `${attempts} of ${MAX_CONTENT_PUBLISH_ATTEMPTS}` },
                  { label: "Provider id", value: item.externalId ? <span className="font-mono text-meta">{item.externalId}</span> : "—" },
                  {
                    label: "Approval",
                    value: approval ? (
                      <Link href="/approvals" className="text-primary underline underline-offset-2">
                        {approval.status === "pending" ? "Waiting in Approvals" : `${approval.status} ${formatDateTime(approval.decidedAt)}`}
                      </Link>
                    ) : (
                      "Not requested"
                    ),
                  },
                ]}
              />
            </div>
          </Section>

          {item.taskId ? (
            <Section title="Task">
              <Link href={`/tasks/${item.taskId}`} className="text-sm text-primary underline underline-offset-2">
                Open the month&rsquo;s task
              </Link>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
