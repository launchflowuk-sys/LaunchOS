import { listClients, listMembers, listTasks, type TaskFilters } from "@launchos/core";
import { schema } from "@launchos/db";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { NewTaskDialog } from "./new-task-dialog";
import { TaskBoard } from "./task-board";
import { TaskFilterBar } from "./task-filters";
import { TaskStatusForm } from "./task-row-status";

export const dynamic = "force-dynamic";

// Read here, in a server component, and handed to the client components as
// plain arrays: importing @launchos/db from a client component would pull the
// postgres driver into the browser bundle.
const STATUSES = schema.taskStatusEnum.enumValues;
const PHASES = schema.taskPhaseEnum.enumValues;
const KINDS = schema.taskKindEnum.enumValues;
const PRIORITIES = schema.taskPriorityEnum.enumValues;

/** An empty GET-form field arrives as "", which means "no filter". */
const one = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.length > 0 ? raw : undefined;
};

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const session = await requireAdmin();
  const sp = await searchParams;
  const view = one(sp.view) === "board" ? "board" : "list";

  const client = one(sp.client);
  const assignee = one(sp.assignee);
  const phase = one(sp.phase);
  const kind = one(sp.kind);
  const status = one(sp.status);
  const dueFrom = one(sp.dueFrom);
  const dueTo = one(sp.dueTo);

  // Built with spreads rather than `key: undefined`: the app compiles with
  // exactOptionalPropertyTypes, so an absent filter has to be an absent key.
  const filters: TaskFilters = {
    ...(client ? { clientId: client } : {}),
    ...(assignee ? { assigneeUserId: assignee } : {}),
    ...(phase ? { phase: phase as NonNullable<TaskFilters["phase"]> } : {}),
    ...(kind ? { kind: kind as NonNullable<TaskFilters["kind"]> } : {}),
    ...(status ? { status: [status as NonNullable<TaskFilters["status"]>[number]] } : {}),
    ...(dueFrom ? { dueFrom: new Date(`${dueFrom}T00:00:00.000Z`) } : {}),
    ...(dueTo ? { dueTo: new Date(`${dueTo}T23:59:59.999Z`) } : {}),
  };

  const [tasks, clients, members] = await Promise.all([
    listTasks(getDb(), session.organisationId, filters),
    listClients(getDb(), session.organisationId, { limit: 200 }),
    listMembers(getDb(), session.organisationId),
  ]);

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));
  const memberOptions = members.map((m) => ({ value: m.userId, label: m.displayName ?? m.name ?? m.email }));
  const other = view === "board" ? "list" : "board";

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Onboarding, recurring service work and support tasks across every client."
        actions={
          <>
            <Link
              href={{ pathname: "/tasks", query: { ...sp, view: other } }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              {other === "board" ? "Board view" : "List view"}
            </Link>
            <NewTaskDialog
              clients={clientOptions}
              members={memberOptions}
              phases={PHASES}
              kinds={KINDS}
              priorities={PRIORITIES}
            />
          </>
        }
      />

      <TaskFilterBar
        clients={clientOptions}
        members={memberOptions}
        current={{ view, client, assignee, phase, kind, status, dueFrom, dueTo }}
      />

      {tasks.length === 0 ? (
        <EmptyState>
          No tasks match these filters. Create one, or give a client a package so onboarding generates its list.
        </EmptyState>
      ) : view === "board" ? (
        <TaskBoard tasks={tasks} statuses={STATUSES} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link href={`/tasks/${task.id}`} className="font-medium text-neutral-900 hover:underline">
                      {task.title}
                    </Link>
                    <span className="ml-2 text-xs text-neutral-400">{task.kind.replaceAll("_", " ")}</span>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${task.clientId}`} className="hover:underline">
                      {task.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={task.phase} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={task.priority} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(task.dueAt)}</TableCell>
                  <TableCell className="text-neutral-600">{task.assigneeName ?? "Unassigned"}</TableCell>
                  <TableCell>
                    <TaskStatusForm taskId={task.id} status={task.status} statuses={STATUSES} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
