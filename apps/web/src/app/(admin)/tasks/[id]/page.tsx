import { getClient, getTask, listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import { Check } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { TimerControls } from "@/components/timer-controls";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { runningEntryFor } from "../../time/running";
import { assignTaskAction, commentOnTaskAction, setTaskVisibilityAction, toggleChecklistAction } from "../actions";
import { TaskStatusForm } from "../task-row-status";

export const dynamic = "force-dynamic";

// Read here, in a server component, and handed to the client component as a
// plain array: importing @launchos/db from a client component would pull the
// postgres driver into the browser bundle.
const STATUSES = schema.taskStatusEnum.enumValues;

export default async function TaskDetailPage({ params }: PageProps<"/tasks/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;

  // getTask filters on the organisation, so another org's id is a 404 here.
  const loaded = await getTask(getDb(), session.organisationId, id);
  if (!loaded) notFound();
  const { task, comments } = loaded;

  const [client, members, running] = await Promise.all([
    getClient(getDb(), session.organisationId, task.clientId),
    listMembers(getDb(), session.organisationId),
    runningEntryFor(session),
  ]);

  return (
    <>
      <PageHeader
        title={task.title}
        description={`${task.phase} · ${task.kind.replaceAll("_", " ")} · ${client?.name ?? "Unknown client"}`}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">
            <StatusBadge value={task.status} />
            <TaskStatusForm taskId={task.id} status={task.status} statuses={STATUSES} />
            <TimerControls target={{ taskId: task.id }} running={running} />
          </div>
        }
      />

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Section title="Description">
            {task.descriptionMd ? (
              <div className="prose prose-sm max-w-none rounded-xl border bg-card p-4">
                <Markdown>{task.descriptionMd}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </Section>

          <Section title="Checklist">
            {task.checklist.length === 0 ? (
              <p className="text-sm text-muted-foreground">No checklist on this task.</p>
            ) : (
              <ul className="grid gap-2 rounded-xl border bg-card p-4">
                {task.checklist.map((item, index) => (
                  <li key={`${index}-${item.label}`} className="flex items-center gap-3">
                    <ActionForm action={toggleChecklistAction} className="flex">
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="index" value={index} />
                      <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                      <button
                        type="submit"
                        aria-label={item.done ? `Undo ${item.label}` : `Complete ${item.label}`}
                        className={
                          item.done
                            ? "flex size-5 items-center justify-center rounded-[4px] border border-primary bg-primary text-primary-foreground transition-colors"
                            : "flex size-5 items-center justify-center rounded-[4px] border border-input transition-colors hover:bg-muted"
                        }
                      >
                        {item.done ? <Check aria-hidden strokeWidth={2.5} className="size-3.5" /> : null}
                      </button>
                    </ActionForm>
                    <span className={item.done ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Comments">
            <ul className="mb-4 grid gap-3">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-xl border bg-card p-4">
                  <p className="text-meta text-muted-foreground">
                    {comment.authorKind} · {formatDateTime(comment.createdAt)}
                  </p>
                  <div className="prose prose-sm mt-1 max-w-none">
                    <Markdown>{comment.bodyMd}</Markdown>
                  </div>
                </li>
              ))}
              {comments.length === 0 ? <li className="text-sm text-muted-foreground">No comments yet.</li> : null}
            </ul>
            <ActionForm
              action={commentOnTaskAction}
              ariaLabel="Add comment"
              success="Comment added"
              resetOnSuccess
              className="grid gap-2"
            >
              <input type="hidden" name="taskId" value={task.id} />
              <Textarea name="bodyMd" rows={3} required aria-label="Comment" placeholder="Add a comment" />
              <div className="flex justify-end">
                <Button type="submit" variant="secondary" className="max-sm:w-full">
                  Add comment
                </Button>
              </div>
            </ActionForm>
          </Section>
        </div>

        <div className="min-w-0">
          <Section title="Details">
            <div className="rounded-xl border bg-card p-4">
              <KeyValue
                items={[
                  { label: "Priority", value: <StatusBadge value={task.priority} /> },
                  { label: "Due", value: formatDateTime(task.dueAt) },
                  { label: "Completed", value: formatDateTime(task.completedAt) },
                  {
                    label: "Client",
                    value: (
                      <Link href={`/clients/${task.clientId}/tasks`} className="hover:underline">
                        {client?.name ?? "—"}
                      </Link>
                    ),
                  },
                ]}
              />
            </div>
          </Section>

          <Section title="Assignee">
            <ActionForm
              action={assignTaskAction}
              ariaLabel="Assignee"
              success="Assignee saved"
              className="flex items-end gap-2"
            >
              <input type="hidden" name="taskId" value={task.id} />
              <NativeSelect
                name="assigneeUserId"
                defaultValue={task.assigneeUserId ?? ""}
                aria-label="Assignee"
                className="min-w-0 flex-1"
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName ?? member.name ?? member.email}
                  </option>
                ))}
              </NativeSelect>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </ActionForm>
          </Section>

          <Section title="Client portal">
            <p className="mb-3 text-sm text-muted-foreground">
              {task.clientVisible ? "Visible to the client." : "Hidden from the client."}
            </p>
            <ActionForm action={setTaskVisibilityAction} ariaLabel="Client portal visibility">
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="clientVisible" value={task.clientVisible ? "false" : "true"} />
              <Button type="submit" variant="secondary" className="max-sm:w-full">
                {task.clientVisible ? "Hide from client" : "Show to client"}
              </Button>
            </ActionForm>
          </Section>
        </div>
      </div>
    </>
  );
}
