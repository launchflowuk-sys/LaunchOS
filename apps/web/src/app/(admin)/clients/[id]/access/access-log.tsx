import type { AccessLogRow } from "@launchos/core";
import { History } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";

/** `client_access.revealed` → "Revealed", with the tone that says how much it matters. */
const ACTIONS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  "client_access.revealed": { label: "Revealed", tone: "warn" },
  "client_access.created": { label: "Added", tone: "success" },
  "client_access.updated": { label: "Changed", tone: "info" },
  "client_access.deleted": { label: "Deleted", tone: "danger" },
};

function describe(action: string): { label: string; tone: StatusTone } {
  return ACTIONS[action] ?? { label: action.replace("client_access.", ""), tone: "neutral" };
}

const COLUMNS: readonly DataListColumn<AccessLogRow>[] = [
  {
    key: "what",
    header: "What",
    primary: true,
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <StatusBadge value={describe(row.action).label} tone={describe(row.action).tone} />
        <span>{row.label ?? "an entry"}</span>
      </span>
    ),
  },
  { key: "who", header: "Who", cell: (row) => row.actorName ?? (row.actorId ? "a former member" : row.actorKind) },
  { key: "when", header: "When", className: "whitespace-nowrap", cell: (row) => formatDateTime(row.createdAt) },
];

/** The last fifty things that happened to this client's entries, reveals included. */
export function AccessLogSection({ rows }: { rows: readonly AccessLogRow[] }) {
  return (
    <Section title="Access log" description="Every reveal, addition, change and deletion, newest first. Deleted entries keep their trail.">
      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Access log"
        empty={<EmptyState icon={History}>Nothing has been revealed or changed yet.</EmptyState>}
      />
    </Section>
  );
}
