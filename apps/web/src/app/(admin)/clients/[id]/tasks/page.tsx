import { FINISHED_STATUSES, getClient, listMembers, listTasks, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
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

export default async function ClientTasksPage({ params }: PageProps<"/clients/[id]/tasks">) {
  const session = await requireAdmin();
  const { id } = await params;

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
  const assigneeOf = (task: TaskListRow) =>
    (task.assigneeUserId ? memberLabels.get(task.assigneeUserId) : null) ?? task.assigneeName ?? "Unassigned";

  const onboarding = progressOf(tasks, "onboarding");
  const recurring = progressOf(tasks, "recurring");

  return (
    <>
      <PageHeader title={client.name} description="Onboarding, recurring service work and support for this client." />

      <ClientTabs clientId={client.id} active="tasks" />

      <div className="space-y-4">
        <section className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-2">
          <ProgressBar label="Onboarding" done={onboarding.done} total={onboarding.total} />
          <ProgressBar label="Recurring service work" done={recurring.done} total={recurring.total} />
          <p className="text-xs text-neutral-500 sm:col-span-2">
            Onboarded {formatDateTime(client.onboardedAt)} · Handed over {formatDateTime(client.handoverAt)}
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <NewTaskDialog
            clients={[{ value: client.id, label: client.name }]}
            members={memberOptions}
            phases={PHASES}
            kinds={KINDS}
            priorities={PRIORITIES}
            defaultClientId={client.id}
          />
          <ActionForm
            action={regenerateOnboardingAction}
            ariaLabel="Generate onboarding tasks"
            success="Onboarding tasks generated"
          >
            <input type="hidden" name="clientId" value={client.id} />
            <Button type="submit" variant="outline">
              Generate onboarding tasks
            </Button>
          </ActionForm>
        </div>

        {tasks.length === 0 ? (
          <EmptyState>
            No tasks yet. Give this client a package, add onboarding templates in Settings, then use “Generate
            onboarding tasks”.
          </EmptyState>
        ) : (
          GROUPS.filter((group) => tasks.some((task) => task.phase === group.phase)).map((group) => (
            <section key={group.phase}>
              <h2 className="mb-2 text-sm font-semibold text-neutral-900">{group.heading}</h2>
              <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Task</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead>Client sees</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks
                      .filter((task) => task.phase === group.phase)
                      .map((task) => (
                        <TableRow key={task.id}>
                          <TableCell>
                            <Link href={`/tasks/${task.id}`} className="font-medium text-neutral-900 hover:underline">
                              {task.title}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <StatusBadge value={task.kind} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-neutral-600">
                            {formatDateTime(task.dueAt)}
                          </TableCell>
                          <TableCell className="text-neutral-600">{assigneeOf(task)}</TableCell>
                          <TableCell>
                            <ActionForm action={setTaskVisibilityAction} ariaLabel={`Client visibility: ${task.title}`}>
                              <input type="hidden" name="taskId" value={task.id} />
                              <input
                                type="hidden"
                                name="clientVisible"
                                value={task.clientVisible ? "false" : "true"}
                              />
                              <button
                                type="submit"
                                className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
                              >
                                {task.clientVisible ? "Visible" : "Hidden"}
                              </button>
                            </ActionForm>
                          </TableCell>
                          <TableCell>
                            <TaskStatusForm taskId={task.id} status={task.status} statuses={STATUSES} />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}
