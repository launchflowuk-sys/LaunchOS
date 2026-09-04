import type { TaskListRow } from "@launchos/core";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { TaskStatusForm } from "./task-row-status";

/**
 * `cancelled` is deliberately absent: cancelled work stays visible in the list
 * view (and via the status filter) but does not deserve a column of its own.
 */
const COLUMNS = ["todo", "in_progress", "blocked", "review", "done"] as const;

export function TaskBoard({ tasks, statuses }: { tasks: TaskListRow[]; statuses: readonly string[] }) {
  return (
    <div className="grid gap-3 overflow-x-auto md:grid-cols-2 xl:grid-cols-5">
      {COLUMNS.map((column) => {
        const label = column.replaceAll("_", " ");
        const cards = tasks.filter((t) => t.status === column);
        return (
          <section
            key={column}
            aria-label={label}
            className="min-w-56 rounded-lg border border-neutral-200 bg-neutral-50 p-2"
          >
            <header className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</h2>
              <span className="text-xs tabular-nums text-neutral-400">{cards.length}</span>
            </header>
            <div className="space-y-2">
              {cards.map((task) => (
                <article key={task.id} className="rounded-md border border-neutral-200 bg-white p-2.5">
                  <Link
                    href={`/tasks/${task.id}`}
                    className="block text-sm font-medium text-neutral-900 hover:underline"
                  >
                    {task.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-neutral-500">{task.clientName}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={task.priority} />
                    <StatusBadge value={task.phase} />
                  </div>
                  <p className="mt-2 text-xs text-neutral-500">
                    {task.dueAt ? `Due ${formatDateTime(task.dueAt)}` : "No due date"}
                    {task.assigneeName ? ` · ${task.assigneeName}` : " · Unassigned"}
                  </p>
                  <div className="mt-2">
                    <TaskStatusForm taskId={task.id} status={task.status} statuses={statuses} />
                  </div>
                </article>
              ))}
              {cards.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-neutral-400">Nothing here</p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
