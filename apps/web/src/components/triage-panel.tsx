import type { TicketTriage } from "@launchos/db/schema";
import { Sparkles } from "lucide-react";
import { KeyValue } from "@/components/key-value";
import { EmptyState } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

/**
 * `tickets.triage` as the Support Triage agent wrote it. Presentational only —
 * the agent's judgement, not a decision anyone has acted on yet.
 */
export function TriagePanel({ triage }: { triage: TicketTriage | null }) {
  if (!triage) return <EmptyState icon={Sparkles}>Not triaged yet.</EmptyState>;

  return (
    <KeyValue
      items={[
        { label: "Category", value: triage.category },
        { label: "Severity", value: <StatusBadge value={triage.severity} /> },
        { label: "Summary", value: <span className="whitespace-pre-wrap">{triage.summary}</span> },
        { label: "Suggested fix", value: <span className="whitespace-pre-wrap">{triage.suggestedFix}</span> },
        {
          label: "Confidence",
          value: <span className="tabular-nums">{Math.round(triage.confidence * 100)}%</span>,
        },
      ]}
    />
  );
}
