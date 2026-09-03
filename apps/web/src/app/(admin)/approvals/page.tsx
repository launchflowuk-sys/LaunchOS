import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime, formatJson } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { approveApproval, rejectApproval } from "./actions";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const session = await requireAdmin();

  const rows = await getDb()
    .select({
      approval: schema.approvals,
      agentKey: schema.agentRuns.agentKey,
      runStatus: schema.agentRuns.status,
    })
    .from(schema.approvals)
    .leftJoin(schema.agentRuns, eq(schema.approvals.runId, schema.agentRuns.id))
    .where(
      and(eq(schema.approvals.organisationId, session.organisationId), eq(schema.approvals.status, "pending")),
    )
    .orderBy(asc(schema.approvals.createdAt));

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward-facing agent actions parked for a human decision."
      />

      <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Approving records the decision only. Resume arrives in Plan 2.
      </p>

      {rows.length === 0 ? (
        <EmptyState>Nothing waiting for a decision.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {rows.map(({ approval, agentKey, runStatus }) => (
            <li key={approval.id} className="rounded-lg border border-neutral-200 bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">{approval.title}</h2>
                <StatusBadge value={approval.kind} tone="neutral" />
                <StatusBadge value={approval.status} />
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

                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Payload</p>
                  <pre className="max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
                    {formatJson(approval.payload)}
                  </pre>
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <form action={approveApproval} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="approvalId" value={approval.id} />
                    <label className="flex flex-col gap-1 text-xs text-neutral-500">
                      Decision note (optional)
                      <input
                        type="text"
                        name="note"
                        maxLength={1000}
                        className="h-8 w-72 rounded-md border border-neutral-300 px-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
                      />
                    </label>
                    <Button type="submit">Approve</Button>
                  </form>
                  <form action={rejectApproval}>
                    <input type="hidden" name="approvalId" value={approval.id} />
                    <Button type="submit" variant="destructive">
                      Reject
                    </Button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
