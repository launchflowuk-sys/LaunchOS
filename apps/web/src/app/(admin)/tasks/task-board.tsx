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

/** "Alex Contact" → "AC"; an unassigned task gets a dash rather than a guess. */
function initialsOf(name: string | null): string {
  if (!name) return "–";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "–";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function TaskBoard({ tasks, statuses }: { tasks: TaskListRow[]; statuses: readonly string[] }) {
  return (
    // The lanes scroll sideways inside this box. Nothing here may widen the
    // page: `min-w-0` on the scroller, `shrink-0` on each lane.
    <div className="-mx-1 flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
      {COLUMNS.map((column) => {
        const label = column.replaceAll("_", " ");
        const cards = tasks.filter((t) => t.status === column);
        return (
          <section key={column} aria-label={label} className="w-72 shrink-0 snap-start rounded-xl bg-muted/60 p-2">
            <header className="mb-2 flex items-center justify-between gap-2 px-1.5 py-1">
              <h2 className="label-caps truncate text-muted-foreground">{label}</h2>
              <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{cards.length}</span>
            </header>
            {/* Each lane scrolls its own cards: a client with two hundred open
                tasks must not turn the page into a mile of grey. */}
            <div className="grid max-h-[70vh] gap-2 overflow-y-auto">
              {cards.map((task) => (
                <article key={task.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/tasks/${task.id}`} className="min-w-0 text-sm font-medium break-words hover:underline">
                      {task.title}
                    </Link>
                    <StatusBadge value={task.priority} className="shrink-0" />
                  </div>
                  <p className="mt-1 truncate text-meta text-muted-foreground">{task.clientName}</p>

                  <div className="mt-3 flex items-center gap-2">
                    {/* A plain span, not the Radix `Avatar`: the board renders
                        every task the filter returns, and a client component
                        per card is hydration this screen cannot afford. */}
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-[10px] font-medium text-muted-foreground"
                    >
                      {initialsOf(task.assigneeName)}
                    </span>
                    <div className="min-w-0 text-meta text-muted-foreground">
                      <p className="truncate">{task.assigneeName ?? "Unassigned"}</p>
                      <p className="truncate">{task.dueAt ? `Due ${formatDateTime(task.dueAt)}` : "No due date"}</p>
                    </div>
                  </div>

                  <div className="mt-3">
                    <TaskStatusForm taskId={task.id} status={task.status} statuses={statuses} />
                  </div>
                </article>
              ))}
              {cards.length === 0 ? (
                <p className="px-1.5 py-6 text-center text-meta text-muted-foreground">Nothing here</p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
