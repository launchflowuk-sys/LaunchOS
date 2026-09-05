import { FINISHED_STATUSES, getClient, listMembers, listTasks, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { setTaskVisibilityAction } from "../../../tasks/actions";
import { NewTaskDialog } from "../../../tasks/new-task-dialog";
import { TaskStatusForm } from "../../../tasks/task-row-status";
import { ClientTabs } from "../tabs";
import { regenerateOnboardingAction } from "./actions";

export const dynamic = "force-dynamic";

// Read in this server component and handed to the client components as plain
// arrays: importing @launchos/db from a client component would pull the
// postgres driver into the browser bundle.
const STATUSES = schema.taskStatusEnum.enumValues;
const PHASES = schema.taskPhaseEnum.enumValues;
const KINDS = schema.taskKindEnum.enumValues;
const PRIORITIES = schema.taskPriorityEnum.enumValues;

const FINISHED = new Set<string>(FINISHED_STATUSES);

/** Grouped in display order; "support" work is ad hoc, so it comes last. */
const GROUPS = [
  { phase: "onboarding", heading: "Onboarding" },
  { phase: "recurring", heading: "Recurring service work" },
  { phase: "support", heading: "Support" },
] as const;

function progressOf(tasks: TaskListRow[], phase: string) {
  const rows = tasks.filter((task) => task.phase === phase);
  return { done: rows.filter((task) => FINISHED.has(task.status)).length, total: rows.length };
}

type Row = TaskListRow & { assignee: string };

function columns(statuses: readonly string[]): readonly DataListColumn<Row>[] {
  return [
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
    { key: "priority", header: "Priority", cell: (task) => <StatusBadge value={task.priority} /> },
    { key: "due", header: "Due", className: "whitespace-nowrap", cell: (task) => formatDateTime(task.dueAt) },
    { key: "assignee", header: "Assignee", cell: (task) => task.assignee },
    {
      key: "visibility",
      header: "Client sees",
      cell: (task) => (
        <ActionForm action={setTaskVisibilityAction} ariaLabel={`Client visibility: ${task.title}`}>
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="clientVisible" value={task.clientVisible ? "false" : "true"} />
          <Button type="submit" size="sm" variant="secondary">
            {task.clientVisible ? "Visible" : "Hidden"}
          </Button>
        </ActionForm>
      ),
    },
    { key: "status", header: "Status", status: true, cell: (task) => <StatusBadge value={task.status} /> },
    {
      key: "move",
      header: "Change status",
      action: true,
      cell: (task) => <TaskStatusForm taskId={task.id} status={task.status} statuses={statuses} />,
    },
  ];
}

export default async function ClientTasksPage({ params }: PageProps<"/clients/[id]/tasks">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);

  const client = await getClient(getDb(), session.organisationId, id);
  if (!client) notFound();

  const [tasks, members] = await Promise.all([
    listTasks(getDb(), session.organisationId, { clientId: id }),
    listMembers(getDb(), session.organisationId),
  ]);

  // listTasks resolves an assignee to their org display name, which is optional.
  // The member list carries the account name and email too, so the column shows
  // a person rather than "Unassigned" for a member who never set a display name.
  const memberOptions = members.map((member) => ({
    value: member.userId,
    label: member.displayName ?? member.name ?? member.email,
  }));
  const memberLabels = new Map(memberOptions.map((member) => [member.value, member.label]));
  const rows: Row[] = tasks.map((task) => ({
    ...task,
    assignee: (task.assigneeUserId ? memberLabels.get(task.assigneeUserId) : null) ?? task.assigneeName ?? "Unassigned",
  }));

  const onboarding = progressOf(tasks, "onboarding");
  const recurring = progressOf(tasks, "recurring");
  const COLUMNS = columns(STATUSES);

  return (
    <>
      <PageHeader
        title={client.name}
        description="Onboarding, recurring service work and support for this client."
        category="delivery"
        actions={
          <>
            <ActionForm
              action={regenerateOnboardingAction}
              ariaLabel="Generate onboarding tasks"
              success="Onboarding tasks generated"
              className="max-sm:w-full"
            >
              <input type="hidden" name="clientId" value={client.id} />
              <Button type="submit" variant="secondary" className="max-sm:w-full">
                Generate onboarding tasks
              </Button>
            </ActionForm>
            <NewTaskDialog
              clients={[{ value: client.id, label: client.name }]}
              members={memberOptions}
              phases={PHASES}
              kinds={KINDS}
              priorities={PRIORITIES}
              defaultClientId={client.id}
            />
          </>
        }
      />

      <ClientTabs clientId={client.id} active="tasks" />

      <Section title="Progress">
        <div className="grid gap-5 rounded-xl border bg-card p-4 sm:grid-cols-2">
          <ProgressBar label="Onboarding" done={onboarding.done} total={onboarding.total} />
          <ProgressBar label="Recurring service work" done={recurring.done} total={recurring.total} />
          <p className="text-meta text-muted-foreground sm:col-span-2">
            Onboarded {formatDateTime(client.onboardedAt)} · Handed over {formatDateTime(client.handoverAt)}
          </p>
        </div>
      </Section>

      {rows.length === 0 ? (
        <Section>
          <EmptyState icon={ListChecks}>
            No tasks yet. Give this client a package, add onboarding templates in Settings, then use &ldquo;Generate
            onboarding tasks&rdquo;.
          </EmptyState>
        </Section>
      ) : (
        GROUPS.filter((group) => rows.some((task) => task.phase === group.phase)).map((group) => (
          <Section key={group.phase} title={group.heading}>
            <DataList
              rows={rows.filter((task) => task.phase === group.phase)}
              columns={COLUMNS}
              getRowKey={(task) => task.id}
              caption={group.heading}
            />
          </Section>
        ))
      )}
    </>
  );
}
