import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatJson } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { approveApproval, rejectApproval } from "./actions";
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

function PendingApproval({ row }: { row: ApprovalRow }) {
  const { approval, agentKey, runStatus } = row;
  const payload = ApprovalPayload.safeParse(approval.payload);
  const description = payload.success ? payload.data.description : undefined;

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
        {description ? (
          <InlineAlert tone="warning" title="What approving does">
            {description.summary}
          </InlineAlert>
        ) : null}

        {description?.details ? <KeyValue items={detailItems(description.details)} columns={2} /> : null}

        <p className="text-meta text-muted-foreground">
          {approval.runId ? (
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

export default async function ApprovalsPage() {
  const session = await requireAdmin();

  // Decided approvals stay on the page: the decision and what happened next
  // are the audit trail a human actually reads.
  const rows = await getDb()
    .select({
      approval: schema.approvals,
      agentKey: schema.agentRuns.agentKey,
      runStatus: schema.agentRuns.status,
      decidedByName: schema.user.name,
    })
    .from(schema.approvals)
    .leftJoin(schema.agentRuns, eq(schema.approvals.runId, schema.agentRuns.id))
    .leftJoin(schema.user, eq(schema.approvals.decidedBy, schema.user.id))
    .where(eq(schema.approvals.organisationId, session.organisationId))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(50);

  // Two lists, not one: what still needs Shoji, and what has already been
  // decided. Mixing them is how a decided card gets read as a live one.
  const pending = rows.filter((r) => r.approval.status === "pending");
  const decided = rows.filter((r) => r.approval.status !== "pending");

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward-facing agent actions parked for a human decision."
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

      {decided.length > 0 ? (
        <Section title="Already decided" description="The last 50 decisions, newest first.">
          <DataList
            rows={decided}
            columns={DECIDED_COLUMNS}
            getRowKey={(row) => row.approval.id}
            caption="Decided approvals"
          />
        </Section>
      ) : null}
    </>
  );
}
