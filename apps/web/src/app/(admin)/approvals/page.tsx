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
 * What the policy gate parks for a tool call. Anything else (a Plan 5 invoice
 * send, say) still renders — it just falls back to the raw payload.
 */
const ApprovalPayload = z.object({ toolName: z.string(), input: z.record(z.string(), z.unknown()) });

/** `pending` is the database's word for it; "awaiting" is Shoji's. */
function statusLabel(status: "pending" | "approved" | "rejected"): string {
  return status === "pending" ? "awaiting" : status;
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
    })
    .from(schema.approvals)
    .leftJoin(schema.agentRuns, eq(schema.approvals.runId, schema.agentRuns.id))
    .where(eq(schema.approvals.organisationId, session.organisationId))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(50);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward-facing agent actions parked for a human decision."
      />

      <p className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
        Approving runs the tool and resumes the agent. Rejecting tells the agent why and lets it continue.
      </p>

      {rows.length === 0 ? (
        <EmptyState>Nothing waiting for a decision.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {rows.map(({ approval, agentKey, runStatus }) => {
            const payload = ApprovalPayload.safeParse(approval.payload);
            return (
              <li key={approval.id} className="rounded-lg border border-neutral-200 bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3">
                  <h2 className="text-sm font-semibold text-neutral-900">{approval.title}</h2>
                  <StatusBadge value={approval.kind} tone="neutral" />
                  <StatusBadge
                    value={statusLabel(approval.status)}
                    {...(approval.status === "pending" ? { tone: "warn" as const } : {})}
                  />
                  <span className="ml-auto text-xs text-neutral-400">
                    Requested {formatDateTime(approval.createdAt)}
                  </span>
                </div>

                <div className="space-y-4 p-4">
                  <p className="text-xs text-neutral-500">
                    {approval.runId ? (
                      <>
                        Agent <span className="font-medium text-neutral-700">{agentKey ?? "unknown"}</span> (
                        {runStatus ?? "unknown"}) —{" "}
                        <Link href={`/agents/runs/${approval.runId}`} className="underline">
                          view run
                        </Link>
                      </>
                    ) : (
                      "Not linked to an agent run."
                    )}
                  </p>

                  {payload.success ? (
                    <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                      <p className="text-xs uppercase tracking-wide text-neutral-400">Tool</p>
                      <code className="font-mono text-sm text-neutral-900">{payload.data.toolName}</code>
                      <p className="text-xs uppercase tracking-wide text-neutral-400">Input</p>
                      <dl className="space-y-1 text-sm text-neutral-800">
                        {Object.entries(payload.data.input).map(([key, value]) => (
                          <div key={key} className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                            <dt className="text-neutral-500">{key}</dt>
                            <dd className="whitespace-pre-wrap break-words">
                              {typeof value === "string" ? value : formatJson(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}

                  <details>
                    <summary className="cursor-pointer text-xs uppercase tracking-wide text-neutral-400">
                      Raw payload
                    </summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
                      {formatJson(approval.payload)}
                    </pre>
                  </details>

                  {approval.status === "pending" ? (
                    <div className="flex flex-wrap items-end gap-4">
                      <DecisionForm approvalId={approval.id} action={approveApproval} label="Approve" withNote />
                      <DecisionForm
                        approvalId={approval.id}
                        action={rejectApproval}
                        label="Reject"
                        destructive
                        withNote
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-500">
                      {statusLabel(approval.status)} {formatDateTime(approval.decidedAt)}
                      {approval.decisionNote ? ` — ${approval.decisionNote}` : ""}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
