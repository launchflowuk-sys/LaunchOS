import { listClients, listMembers, listTasks, type TaskFilters, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
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

const NO_MATCH =
  "No tasks match these filters. Create one, or give a client a package so onboarding generates its list.";
const PAST_THE_END = "There are no tasks on this page. Go back to a newer page.";

/** An empty GET-form field arrives as "", which means "no filter". */
const one = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.length > 0 ? raw : undefined;
};

const COLUMNS: readonly DataListColumn<TaskListRow>[] = [
  {
    key: "title",
    header: "Task",
    primary: true,
    className: "min-w-52",
    cell: (task) => (
      <>
        <Link href={`/tasks/${task.id}`} className="hover:underline">
          {task.title}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">{task.kind.replaceAll("_", " ")}</span>
      </>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: (task) => (
      <Link href={`/clients/${task.clientId}`} className="hover:underline">
        {task.clientName}
      </Link>
    ),
  },
  { key: "phase", header: "Phase", hideOnMobile: true, cell: (task) => <StatusBadge value={task.phase} /> },
  { key: "priority", header: "Priority", cell: (task) => <StatusBadge value={task.priority} /> },
  { key: "due", header: "Due", className: "whitespace-nowrap", cell: (task) => formatDateTime(task.dueAt) },
  { key: "assignee", header: "Assignee", cell: (task) => task.assigneeName ?? "Unassigned" },
  { key: "status", header: "Status", status: true, cell: (task) => <StatusBadge value={task.status} /> },
  {
    key: "move",
    header: "Change status",
    action: true,
    cell: (task) => <TaskStatusForm taskId={task.id} status={task.status} statuses={STATUSES} />,
  },
];

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
  // Newest first, not soonest-due first: this list is capped at `listTasks`'
  // limit, and under due order an undated task sorts behind every dated one and
  // then behind every older undated one — so a task the operator just created
  // would land off the end of the page. The due date stays a column and a
  // filter for anyone who wants to work the diary.
  // The board groups every open task into its column, so it reads the whole
  // (capped) set; the list is one screenful at a time. Without this a phone
  // rendered a card per task — thousands of them, tens of thousands of pixels.
  const page = view === "list" ? pageParam(sp.page) : 1;

  const filters: TaskFilters = {
    sort: "recent",
    ...(view === "list" ? { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE } : {}),
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

  const hasNext = view === "list" && tasks.length > PAGE_SIZE;
  const rows = hasNext ? tasks.slice(0, PAGE_SIZE) : tasks;

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));
  const memberOptions = members.map((m) => ({ value: m.userId, label: m.displayName ?? m.name ?? m.email }));
  const other = view === "board" ? "list" : "board";

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Onboarding, recurring service work and support tasks across every client."
        category="delivery"
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href={{ pathname: "/tasks", query: { ...sp, view: other } }}>
                {other === "board" ? "Board view" : "List view"}
              </Link>
            </Button>
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

      {view === "board" ? (
        rows.length === 0 ? (
          <EmptyState icon={ListChecks}>{NO_MATCH}</EmptyState>
        ) : (
          <TaskBoard tasks={rows} statuses={STATUSES} />
        )
      ) : (
        <>
          <DataList
            rows={rows}
            columns={COLUMNS}
            getRowKey={(task) => task.id}
            caption="Tasks"
            empty={<EmptyState icon={ListChecks}>{page > 1 ? PAST_THE_END : NO_MATCH}</EmptyState>}
          />
          {/* Outside the empty check on purpose: a page past the end has no rows
              and still needs the "Newer" link back. */}
          <Pager
            basePath="/tasks"
            query={{ client, assignee, phase, kind, status, dueFrom, dueTo }}
            page={page}
            hasNext={hasNext}
          />
        </>
      )}
    </>
  );
}
