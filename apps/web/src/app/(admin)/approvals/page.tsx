import { SUBSCRIPTION_CHANGE_LABEL, SubscriptionChangePayload } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatJson, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { approveApproval, rejectApproval } from "./actions";
import { ContentPublishRequest } from "./content-publish-card";
import { DecisionForm } from "./decision-form";

export const dynamic = "force-dynamic";

/**
 * What the policy gate parks for a tool call. `description` is written by the
 * tool's own `describeApproval` from our database rows — never from model text
 * — and is what a human actually reads before releasing an outward action.
 * Anything else (a Plan 5 invoice send, say) still renders: it just falls back
 * to the tool input and the raw payload.
 */
const ApprovalPayload = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  description: z
    .object({
      title: z.string(),
      summary: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

type ApprovalRow = {
  approval: typeof schema.approvals.$inferSelect;
  agentKey: string | null;
  runStatus: string | null;
  decidedByName: string | null;
};

/** `pending` is the database's word for it; "awaiting" is Shoji's. */
function statusLabel(status: "pending" | "approved" | "rejected"): string {
  return status === "pending" ? "awaiting" : status;
}

/** `conversationId` → "Conversation id". Payload keys are written by our own tools. */
function humaniseKey(key: string): string {
  const spaced = key.replaceAll("_", " ").replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function detailItems(details: Record<string, unknown>) {
  return Object.entries(details).map(([key, value]) => ({
    label: humaniseKey(key),
    value: (
      <span className="break-words whitespace-pre-wrap">
        {typeof value === "string" ? value : formatJson(value)}
      </span>
    ),
  }));
}

/** A disclosure of raw machine detail. Closed by default; the summary says what it holds. */
function Disclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <details className="rounded-lg border bg-muted/40 px-3 py-2">
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/**
 * A client asking to change their plan — the one approval a client raises. The
 * card reads as the owner would say it: who, what they asked, in their words.
 */
function SubscriptionChangeRequest({ approval }: { approval: ApprovalRow["approval"] }) {
  const payload = SubscriptionChangePayload.safeParse(approval.payload);
  if (!payload.success) return null;
  const request = payload.data;

  return (
    <>
      <InlineAlert tone="warning" title="What approving does">
        {request.kind === "cancel"
          ? `${request.summary} Approving cancels the subscription at the end of the current period; the client is emailed either way.`
          : `${request.summary} Approving records the decision — the package is changed by hand on the client's billing tab; the client is emailed either way.`}
      </InlineAlert>
      <KeyValue
        columns={2}
        items={[
          {
            label: "Client",
            value: (
              <Link href={`/clients/${request.clientId}`} className="text-primary underline underline-offset-2">
                {request.clientName}
              </Link>
            ),
          },
          { label: "Request", value: SUBSCRIPTION_CHANGE_LABEL[request.kind] },
          { label: "Current package", value: request.packageName },
          { label: "Monthly", value: formatPence(request.monthlyPricePence, request.currency) },
          {
            label: "Their message",
            value: <span className="break-words whitespace-pre-wrap">{request.message}</span>,
          },
        ]}
      />
    </>
  );
}

function PendingApproval({ row }: { row: ApprovalRow }) {
  const { approval, agentKey, runStatus } = row;
  const payload = ApprovalPayload.safeParse(approval.payload);
  const description = payload.success ? payload.data.description : undefined;
  const isSubscriptionChange = approval.kind === "subscription_change";
  const isContentPublish = approval.kind === "content_publish";

  return (
    // The id is on the card so a test can address exactly one approval: two
    // parked calls on the same thread share a generated title.
    <li data-approval-id={approval.id} className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h3 className="text-base font-semibold">{approval.title}</h3>
        <StatusBadge value={approval.kind} tone="neutral" />
        <StatusBadge value={statusLabel(approval.status)} tone="warn" />
        <span className="ml-auto text-meta text-muted-foreground">
          Requested {formatDateTime(approval.createdAt)}
        </span>
      </div>

      <div className="space-y-4 p-4">
        {isSubscriptionChange ? <SubscriptionChangeRequest approval={approval} /> : null}
        {isContentPublish ? <ContentPublishRequest approval={approval} /> : null}

        {description ? (
          <InlineAlert tone="warning" title="What approving does">
            {description.summary}
          </InlineAlert>
        ) : null}

        {description?.details ? <KeyValue items={detailItems(description.details)} columns={2} /> : null}

        <p className="text-meta text-muted-foreground">
          {isSubscriptionChange ? (
            "Raised by the client from their portal."
          ) : isContentPublish && !approval.runId ? (
            "Sent for approval from the Content screen."
          ) : approval.runId ? (
            <>
              Agent <span className="font-medium text-foreground">{agentKey ?? "unknown"}</span> (
              {runStatus ?? "unknown"}) —{" "}
              <Link href={`/agents/runs/${approval.runId}`} className="text-primary underline underline-offset-2">
                view run
              </Link>
            </>
          ) : (
            "Not linked to an agent run."
          )}
        </p>

        {payload.success ? (
          <Disclosure
            label={
              <>
                <span className="label-caps">Tool call</span>{" "}
                <span className="font-mono text-meta">{payload.data.toolName}</span>
              </>
            }
          >
            <KeyValue items={detailItems(payload.data.input)} />
          </Disclosure>
        ) : null}

        <Disclosure label={<span className="label-caps">Raw payload</span>}>
          <pre className="max-h-72 overflow-auto rounded-lg border bg-card p-3 font-mono text-meta text-muted-foreground">
            {formatJson(approval.payload)}
          </pre>
        </Disclosure>

        <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-end">
          <DecisionForm
            approvalId={approval.id}
            action={approveApproval}
            label="Approve"
            variant="success"
            withNote
            resumesAgent={Boolean(approval.runId)}
          />
          <DecisionForm
            approvalId={approval.id}
            action={rejectApproval}
            label="Reject"
            variant="destructive"
            withNote
            resumesAgent={Boolean(approval.runId)}
          />
        </div>
      </div>
    </li>
  );
}

/** The decided history: the record of who released what, never a second chance to. */
const DECIDED_COLUMNS: readonly DataListColumn<ApprovalRow>[] = [
  {
    key: "title",
    header: "Approval",
    primary: true,
    cell: (row) => <span data-approval-id={row.approval.id}>{row.approval.title}</span>,
  },
  {
    key: "decision",
    header: "Decision",
    status: true,
    cell: (row) => <StatusBadge value={statusLabel(row.approval.status)} />,
  },
  { key: "kind", header: "Kind", cell: (row) => row.approval.kind.replaceAll("_", " ") },
  {
    key: "by",
    header: "Decided by",
    cell: (row) => row.decidedByName ?? row.approval.decidedBy ?? "unknown",
  },
  {
    key: "when",
    header: "Decided",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.approval.decidedAt),
  },
  {
    key: "note",
    header: "Note",
    hideOnMobile: true,
    cell: (row) => row.approval.decisionNote ?? "—",
  },
];

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const session = await requireAdmin();
  const sp = await searchParams;
  const page = pageParam(sp.page);

  const db = getDb();
  const base = () =>
    db
      .select({
        approval: schema.approvals,
        agentKey: schema.agentRuns.agentKey,
        runStatus: schema.agentRuns.status,
        decidedByName: schema.user.name,
      })
      .from(schema.approvals)
      .leftJoin(schema.agentRuns, eq(schema.approvals.runId, schema.agentRuns.id))
      .leftJoin(schema.user, eq(schema.approvals.decidedBy, schema.user.id));

  // Two lists, not one, and two queries rather than one filtered in memory:
  // what still needs Shoji, and what has already been decided. Mixing them is
  // how a decided card gets read as a live one — and a single capped fetch
  // meant a busy week of decisions could push the pending cards off the end of
  // it, hiding the work queue behind its own history.
  //
  // Pending is deliberately unpaged: it is the queue, and every row in it is
  // an outward action parked waiting on a human. Decided approvals stay on the
  // page because the decision and what happened next are the audit trail a
  // human actually reads — but that grows without bound, so it is paged.
  const [pending, decidedRows] = await Promise.all([
    base()
      .where(
        and(eq(schema.approvals.organisationId, session.organisationId), eq(schema.approvals.status, "pending")),
      )
      .orderBy(desc(schema.approvals.createdAt)),
    base()
      .where(and(eq(schema.approvals.organisationId, session.organisationId), ne(schema.approvals.status, "pending")))
      // `decided_at` is when the decision was made and is what the column
      // shows; `id` breaks the tie so an offset page never repeats or skips a
      // row when two decisions share a timestamp.
      .orderBy(desc(schema.approvals.decidedAt), desc(schema.approvals.id))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  const hasNext = decidedRows.length > PAGE_SIZE;
  const decided = hasNext ? decidedRows.slice(0, PAGE_SIZE) : decidedRows;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward-facing actions parked for a human decision — agent tool calls, invoice sends and clients' plan change requests."
        category="automation"
      />

      <InlineAlert tone="info">
        <p>
          Each card says what will actually happen — the client, the address, the exact text — read from our own
          records rather than from the agent. Approving runs the tool and resumes the agent. Rejecting tells the agent
          why and lets it continue.
        </p>
      </InlineAlert>

      <Section title="Waiting for you">
        {pending.length === 0 ? (
          <EmptyState icon={ShieldCheck}>Nothing waiting for a decision.</EmptyState>
        ) : (
          <ul className="grid min-w-0 gap-4">
            {pending.map((row) => (
              <PendingApproval key={row.approval.id} row={row} />
            ))}
          </ul>
        )}
      </Section>

      {decided.length > 0 || page > 1 ? (
        <Section title="Already decided" description="Newest first, fifty to a page.">
          <DataList
            rows={decided}
            columns={DECIDED_COLUMNS}
            getRowKey={(row) => row.approval.id}
            caption="Decided approvals"
            empty={<EmptyState icon={ShieldCheck}>There are no decisions on this page. Go back to a newer page.</EmptyState>}
          />
          {/* Outside the empty check on purpose: a page past the end has no
              rows and still needs the "Newer" link back. */}
          <Pager basePath="/approvals" query={{}} page={page} hasNext={hasNext} />
        </Section>
      ) : null}
    </>
  );
}
