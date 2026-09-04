import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { z } from "zod";
import { EmptyState, PageHeader } from "@/components/page-header";
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

function Labelled({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-sm text-neutral-800">{value}</dd>
    </div>
  );
}

function ApprovalCard({ row }: { row: ApprovalRow }) {
  const { approval, agentKey, runStatus, decidedByName } = row;
  const payload = ApprovalPayload.safeParse(approval.payload);
  const description = payload.success ? payload.data.description : undefined;

  return (
    // The id is on the card so a test can address exactly one approval: two
    // parked calls on the same thread share a generated title.
    <li data-approval-id={approval.id} className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-neutral-900">{approval.title}</h3>
        <StatusBadge value={approval.kind} tone="neutral" />
        <StatusBadge
          value={statusLabel(approval.status)}
          {...(approval.status === "pending" ? { tone: "warn" as const } : {})}
        />
        <span className="ml-auto text-xs text-neutral-400">Requested {formatDateTime(approval.createdAt)}</span>
      </div>

      <div className="space-y-4 p-4">
        {description ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-neutral-800">
            {description.summary}
          </p>
        ) : null}

        <p className="text-xs text-neutral-500">
          {approval.runId ? (
            <>
              Agent <span className="font-medium text-neutral-700">{agentKey ?? "unknown"}</span> ({runStatus ?? "unknown"}) —{" "}
              <Link href={`/agents/runs/${approval.runId}`} className="underline">
                view run
              </Link>
            </>
          ) : (
            "Not linked to an agent run."
          )}
        </p>

        {description?.details ? (
          <dl className="space-y-2">
            {Object.entries(description.details).map(([key, value]) => (
              <Labelled key={key} label={key} value={typeof value === "string" ? value : formatJson(value)} />
            ))}
          </dl>
        ) : null}

        {payload.success ? (
          <details>
            <summary className="cursor-pointer text-xs uppercase tracking-wide text-neutral-400">
              Tool call — {payload.data.toolName}
            </summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(payload.data.input).map(([key, value]) => (
                <Labelled key={key} label={key} value={typeof value === "string" ? value : formatJson(value)} />
              ))}
            </dl>
          </details>
        ) : null}

        <details>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-neutral-400">Raw payload</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
            {formatJson(approval.payload)}
          </pre>
        </details>

        {approval.status === "pending" ? (
          <div className="flex flex-wrap items-end gap-4">
            <DecisionForm
              approvalId={approval.id}
              action={approveApproval}
              label="Approve"
              withNote
              resumesAgent={Boolean(approval.runId)}
            />
            <DecisionForm
              approvalId={approval.id}
              action={rejectApproval}
              label="Reject"
              destructive
              withNote
              resumesAgent={Boolean(approval.runId)}
            />
          </div>
        ) : (
          // Decided: the record of who released it, never a second chance to.
          <p className="text-xs text-neutral-500">
            {statusLabel(approval.status)} by{" "}
            <span className="font-medium text-neutral-700">{decidedByName ?? approval.decidedBy ?? "unknown"}</span>{" "}
            {formatDateTime(approval.decidedAt)}
            {approval.decisionNote ? ` — ${approval.decisionNote}` : ""}
          </p>
        )}
      </div>
    </li>
  );
}

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
      <PageHeader title="Approvals" description="Outward-facing agent actions parked for a human decision." />

      <p className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
        Each card says what will actually happen — the client, the address, the exact text — read from our own records
        rather than from the agent. Approving runs the tool and resumes the agent. Rejecting tells the agent why and
        lets it continue.
      </p>

      <h2 className="mb-3 text-sm font-semibold text-neutral-900">Waiting for you</h2>
      {pending.length === 0 ? (
        <EmptyState>Nothing waiting for a decision.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {pending.map((row) => (
            <ApprovalCard key={row.approval.id} row={row} />
          ))}
        </ul>
      )}

      {decided.length > 0 ? (
        <>
          <h2 className="mb-3 mt-10 border-t border-neutral-200 pt-8 text-sm font-semibold text-neutral-900">
            Already decided
          </h2>
          <ul className="space-y-4">
            {decided.map((row) => (
              <ApprovalCard key={row.approval.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
