import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { Footprints } from "lucide-react";
import { notFound } from "next/navigation";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatJson } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const PAYLOAD = "max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-meta text-muted-foreground";

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
      <PageHeader
        title={run.agentKey}
        description={`Agent run ${run.id}`}
        category="automation"
        actions={<StatusBadge value={run.status} />}
      />

      <Section>
        <div className="rounded-xl border bg-card p-4">
          <KeyValue
            columns={2}
            items={[
              { label: "Status", value: <StatusBadge value={run.status} /> },
              { label: "Trigger", value: run.trigger },
              { label: "Tokens in", value: <span className="tabular-nums">{run.tokensIn}</span> },
              { label: "Tokens out", value: <span className="tabular-nums">{run.tokensOut}</span> },
              { label: "Started", value: formatDateTime(run.startedAt) },
              { label: "Finished", value: formatDateTime(run.finishedAt) },
            ]}
          />
        </div>
      </Section>

      {run.summary ? (
        <Section title="Summary">
          <p className="rounded-xl border bg-card p-4 text-sm whitespace-pre-wrap">{run.summary}</p>
        </Section>
      ) : null}

      {run.error ? (
        <Section title="Error">
          <InlineAlert tone="danger">
            <p className="break-words whitespace-pre-wrap">{run.error}</p>
          </InlineAlert>
        </Section>
      ) : null}

      <Section title="Steps">
        {steps.length === 0 ? (
          <EmptyState icon={Footprints}>This run recorded no steps.</EmptyState>
        ) : (
          <ol className="grid min-w-0 gap-4">
            {steps.map((step) => (
              <li key={step.id} className="min-w-0 overflow-hidden rounded-xl border bg-card">
                <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                  <span className="font-mono text-meta tabular-nums text-muted-foreground">#{step.seq}</span>
                  <StatusBadge value={step.kind} tone="info" />
                  {step.toolName ? <span className="font-mono text-meta">{step.toolName}</span> : null}
                  <span className="ml-auto text-meta text-muted-foreground">{formatDateTime(step.createdAt)}</span>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <div className="min-w-0">
                    <p className="label-caps mb-1.5 text-muted-foreground">Input</p>
                    <pre className={PAYLOAD}>{formatJson(step.input)}</pre>
                  </div>
                  <div className="min-w-0">
                    <p className="label-caps mb-1.5 text-muted-foreground">Output</p>
                    <pre className={PAYLOAD}>{formatJson(step.output)}</pre>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
