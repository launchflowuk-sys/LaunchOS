import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatJson } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AgentRunPage({ params }: PageProps<"/agents/runs/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();

  const [run] = await getDb()
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, id), eq(schema.agentRuns.organisationId, session.organisationId)));

  if (!run) notFound();

  const steps = await getDb()
    .select()
    .from(schema.agentSteps)
    .where(and(eq(schema.agentSteps.runId, run.id), eq(schema.agentSteps.organisationId, session.organisationId)))
    .orderBy(asc(schema.agentSteps.seq));

  return (
    <>
      <PageHeader title={run.agentKey} description={`Agent run ${run.id}`} />

      <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={run.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Trigger</dt>
          <dd className="mt-1 text-neutral-700">{run.trigger}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Tokens in</dt>
          <dd className="mt-1 tabular-nums text-neutral-700">{run.tokensIn}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Tokens out</dt>
          <dd className="mt-1 tabular-nums text-neutral-700">{run.tokensOut}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Started</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Finished</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(run.finishedAt)}</dd>
        </div>
      </dl>

      {run.summary ? (
        <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Summary</h2>
          <p className="text-sm whitespace-pre-wrap text-neutral-700">{run.summary}</p>
        </section>
      ) : null}

      {run.error ? (
        <section className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-red-800">Error</h2>
          <p className="text-sm whitespace-pre-wrap text-red-700">{run.error}</p>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Steps</h2>
        {steps.length === 0 ? (
          <EmptyState>This run recorded no steps.</EmptyState>
        ) : (
          <ol className="space-y-3">
            {steps.map((step) => (
              <li key={step.id} className="rounded-lg border border-neutral-200 bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-2.5">
                  <span className="text-xs font-medium tabular-nums text-neutral-400">#{step.seq}</span>
                  <StatusBadge value={step.kind} tone="info" />
                  {step.toolName ? (
                    <span className="font-mono text-xs text-neutral-700">{step.toolName}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-neutral-400">
                    {formatDateTime(step.createdAt)}
                  </span>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Input</p>
                    <pre className="max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
                      {formatJson(step.input)}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Output</p>
                    <pre className="max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-700">
                      {formatJson(step.output)}
                    </pre>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
