import { listTasks, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import { ListChecks } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PortalProgress } from "@/components/portal/portal-progress";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, string> = {
  onboarding: "Getting you set up",
  recurring: "Ongoing work",
  support: "Support work",
};

/** A phase is finished when the task is done; cancelled work is not counted. */
function progressOf(tasks: readonly TaskListRow[]): { done: number; total: number } {
  const counted = tasks.filter((task) => task.status !== "cancelled");
  return { done: counted.filter((task) => task.status === "done").length, total: counted.length };
}

type TaskRow = { id: string; title: string; status: string; dueAt: Date | null };

const COLUMNS: readonly DataListColumn<TaskRow>[] = [
  { key: "title", header: "Job", primary: true, cell: (row) => row.title },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "due", header: "Due", cell: (row) => (row.dueAt ? formatDate(row.dueAt) : "No date set") },
];

export default async function PortalTasksPage() {
  const session = await requireClient();

  // `clientVisible: true` is not a nicety: it is the switch staff use to keep
  // internal work off this page. Both scope halves come from the session.
  const tasks = await listTasks(getDb(), session.organisationId, {
    clientId: session.clientId,
    clientVisible: true,
    limit: 500,
  });

  const groups = schema.taskPhaseEnum.enumValues
    .map((phase) => ({ phase, tasks: tasks.filter((task) => task.phase === phase) }))
    .filter((group) => group.tasks.length > 0);

  return (
    <>
      <PageHeader
        title="Progress"
        description="Where the work on your account has got to."
        category="delivery"
      />

      {groups.length === 0 ? (
        <EmptyState icon={ListChecks}>
          Nothing to show yet. We will list the work here as it is planned.
        </EmptyState>
      ) : (
        groups.map((group) => {
          const { done, total } = progressOf(group.tasks);
          const label = PHASE_LABEL[group.phase] ?? group.phase;
          return (
            <Section key={group.phase} title={label}>
              <PortalProgress label={label} done={done} total={total} className="mb-4" />
              <DataList rows={group.tasks} columns={COLUMNS} getRowKey={(row) => row.id} caption={label} />
            </Section>
          );
        })
      )}
    </>
  );
}
