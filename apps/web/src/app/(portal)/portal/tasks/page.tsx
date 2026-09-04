import { listTasks, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import { EmptyState, PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
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
      <PageHeader title="Progress" description="Where the work on your account has got to." />

      {groups.length === 0 ? (
        <EmptyState>Nothing to show yet. We will add work here as it is planned.</EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const { done, total } = progressOf(group.tasks);
            return (
              <section key={group.phase} className="rounded-lg border border-neutral-200 bg-white p-5">
                <ProgressBar label={PHASE_LABEL[group.phase] ?? group.phase} done={done} total={total} />

                <ul className="mt-4 divide-y divide-neutral-100">
                  {group.tasks.map((task) => (
                    <li key={task.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">{task.title}</span>
                      <StatusBadge value={task.status} />
                      <span className="w-40 shrink-0 text-right text-xs text-neutral-500">
                        {task.dueAt ? formatDateTime(task.dueAt) : "No date set"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
