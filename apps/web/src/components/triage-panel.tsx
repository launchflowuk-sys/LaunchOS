import type { TicketTriage } from "@launchos/db/schema";
import { EmptyState } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

/**
 * `tickets.triage` as the Support Triage agent wrote it. Presentational only —
 * the agent's judgement, not a decision anyone has acted on yet.
 */
export function TriagePanel({ triage }: { triage: TicketTriage | null }) {
  if (!triage) return <EmptyState>Not triaged yet.</EmptyState>;

  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-neutral-400">Category</dt>
        <dd className="text-neutral-800">{triage.category}</dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-neutral-400">Severity</dt>
        <dd>
          <StatusBadge value={triage.severity} />
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-neutral-400">Summary</dt>
        <dd className="whitespace-pre-wrap text-neutral-800">{triage.summary}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-neutral-400">Suggested fix</dt>
        <dd className="whitespace-pre-wrap text-neutral-800">{triage.suggestedFix}</dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-neutral-400">Confidence</dt>
        <dd className="text-neutral-800">{Math.round(triage.confidence * 100)}%</dd>
      </div>
    </dl>
  );
}
