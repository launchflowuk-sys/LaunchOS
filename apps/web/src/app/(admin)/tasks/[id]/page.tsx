import { getClient, getTask, listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { assignTaskAction, commentOnTaskAction, setTaskVisibilityAction, toggleChecklistAction } from "../actions";
import { TaskStatusForm } from "../task-row-status";

export const dynamic = "force-dynamic";

// Read here, in a server component, and handed to the client component as a
// plain array: importing @launchos/db from a client component would pull the
// postgres driver into the browser bundle.
const STATUSES = schema.taskStatusEnum.enumValues;

const CARD = "rounded-lg border border-neutral-200 bg-white p-4";
const HEADING = "mb-2 text-sm font-semibold text-neutral-900";

export default async function TaskDetailPage({ params }: PageProps<"/tasks/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;

  // getTask filters on the organisation, so another org's id is a 404 here.
  const loaded = await getTask(getDb(), session.organisationId, id);
  if (!loaded) notFound();
  const { task, comments } = loaded;

  const [client, members] = await Promise.all([
    getClient(getDb(), session.organisationId, task.clientId),
    listMembers(getDb(), session.organisationId),
  ]);

  return (
    <>
      <PageHeader
        title={task.title}
        description={`${task.phase} · ${task.kind.replaceAll("_", " ")} · ${client?.name ?? "Unknown client"}`}
        actions={<TaskStatusForm taskId={task.id} status={task.status} statuses={STATUSES} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className={CARD}>
            <h2 className={HEADING}>Description</h2>
            {task.descriptionMd ? (
              <div className="prose prose-sm max-w-none text-neutral-700">
                <Markdown>{task.descriptionMd}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-neutral-400">No description.</p>
            )}
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Checklist</h2>
            {task.checklist.length === 0 ? (
              <p className="text-sm text-neutral-400">No checklist on this task.</p>
            ) : (
              <ul className="space-y-1.5">
                {task.checklist.map((item, index) => (
                  <li key={`${index}-${item.label}`} className="flex items-center gap-2">
                    <ActionForm action={toggleChecklistAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="index" value={index} />
                      <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                      <button
                        type="submit"
                        aria-label={item.done ? `Undo ${item.label}` : `Complete ${item.label}`}
                        className="flex h-5 w-5 items-center justify-center rounded border border-neutral-300 text-xs text-neutral-700 hover:bg-neutral-100"
                      >
                        {item.done ? "x" : ""}
                      </button>
                    </ActionForm>
                    <span className={item.done ? "text-sm text-neutral-400 line-through" : "text-sm text-neutral-800"}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Comments</h2>
            <ul className="mb-3 space-y-3">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-md bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">
                    {comment.authorKind} · {formatDateTime(comment.createdAt)}
                  </p>
                  <div className="prose prose-sm mt-1 max-w-none text-neutral-800">
                    <Markdown>{comment.bodyMd}</Markdown>
                  </div>
                </li>
              ))}
              {comments.length === 0 ? <li className="text-sm text-neutral-400">No comments yet.</li> : null}
            </ul>
            <ActionForm
              action={commentOnTaskAction}
              ariaLabel="Add comment"
              success="Comment added"
              resetOnSuccess
              className="space-y-2"
            >
              <input type="hidden" name="taskId" value={task.id} />
              <textarea
                name="bodyMd"
                rows={3}
                required
                aria-label="Comment"
                placeholder="Add a comment"
                className="w-full rounded-md border border-neutral-300 p-2 text-sm"
              />
              <Button type="submit" variant="secondary">
                Add comment
              </Button>
            </ActionForm>
          </section>
        </div>

        <aside className="space-y-4">
          <section className={`${CARD} space-y-2 text-sm`}>
            <h2 className="text-sm font-semibold text-neutral-900">Details</h2>
            <p className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">Status</span>
              <StatusBadge value={task.status} />
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">Priority</span>
              <StatusBadge value={task.priority} />
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">Due</span>
              <span className="text-neutral-800">{formatDateTime(task.dueAt)}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">Completed</span>
              <span className="text-neutral-800">{formatDateTime(task.completedAt)}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">Client</span>
              <Link href={`/clients/${task.clientId}/tasks`} className="text-neutral-900 hover:underline">
                {client?.name ?? "—"}
              </Link>
            </p>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Assignee</h2>
            <ActionForm
              action={assignTaskAction}
              ariaLabel="Assignee"
              success="Assignee saved"
              className="flex items-center gap-2"
            >
              <input type="hidden" name="taskId" value={task.id} />
              <select
                name="assigneeUserId"
                defaultValue={task.assigneeUserId ?? ""}
                aria-label="Assignee"
                className="h-9 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-sm"
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName ?? member.name ?? member.email}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </ActionForm>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Client portal</h2>
            <p className="mb-2 text-sm text-neutral-600">
              {task.clientVisible ? "Visible to the client." : "Hidden from the client."}
            </p>
            <ActionForm action={setTaskVisibilityAction} ariaLabel="Client portal visibility">
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="clientVisible" value={task.clientVisible ? "false" : "true"} />
              <Button type="submit" variant="secondary">
                {task.clientVisible ? "Hide from client" : "Show to client"}
              </Button>
            </ActionForm>
          </section>
        </aside>
      </div>
    </>
  );
}
