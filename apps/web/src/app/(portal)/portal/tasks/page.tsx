import { listTasks, type TaskListRow } from "@launchos/core";
import { schema } from "@launchos/db";
import type { TaskEvidenceChecklistItem } from "@launchos/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Check, ListChecks } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PortalProgress } from "@/components/portal/portal-progress";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { ClientReviews } from "./client-reviews";
import { ClientProjects } from "./project-progress";
import { PublishedStory } from "./published-story";
import { WeeklyUpdate } from "./weekly-update";

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

/**
 * The proof checklists staff tick on a task, shown to the client read-only:
 * this is the "how do I know it was actually done?" answer for somebody who
 * cannot see the work. Only tasks that carry a checklist appear; links and
 * screenshots stay internal (they can point at staging or at admin screens).
 */
function ProofChecklists({ items }: { items: readonly { id: string; title: string; checklist: readonly TaskEvidenceChecklistItem[] }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border bg-card p-4 sm:p-5">
      <p className="text-sm font-semibold">Proof of work</p>
      <ul className="mt-3 grid gap-4">
        {items.map((task) => (
          <li key={task.id}>
            <p className="text-sm">{task.title}</p>
            <ul className="mt-1.5 grid gap-1.5">
              {task.checklist.map((item, index) => (
                <li key={`${index}-${item.item}`} className="flex items-center gap-2 text-sm">
                  <span
                    aria-label={item.done ? "Done" : "Not yet"}
                    className={
                      item.done
                        ? "flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-success-fg text-white"
                        : "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input"
                    }
                  >
                    {item.done ? <Check aria-hidden strokeWidth={3} className="size-3" /> : null}
                  </span>
                  <span className={item.done ? "text-muted-foreground" : ""}>{item.item}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

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

  // The list row carries no evidence; the checklists come from the same
  // rows, scoped again by organisation, client and visibility.
  const evidenceRows =
    tasks.length === 0
      ? []
      : await getDb()
          .select({ id: schema.tasks.id, evidence: schema.tasks.evidence })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organisationId, session.organisationId),
              eq(schema.tasks.clientId, session.clientId),
              eq(schema.tasks.clientVisible, true),
              inArray(
                schema.tasks.id,
                tasks.map((task) => task.id),
              ),
            ),
          );
  const checklistByTask = new Map(
    evidenceRows.filter((row) => row.evidence.checklist.length > 0).map((row) => [row.id, row.evidence.checklist]),
  );

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

      {/* The build first: it is the thing a client signs in to check. Anything
          we have asked them to look at sits under it, framed as an invitation —
          nothing on the build is waiting on them. Then the week's news, then
          the job list, which is the detail behind all three. */}
      <ClientProjects organisationId={session.organisationId} clientId={session.clientId} />

      <ClientReviews organisationId={session.organisationId} clientId={session.clientId} />

      <WeeklyUpdate organisationId={session.organisationId} clientId={session.clientId} />

      <PublishedStory organisationId={session.organisationId} clientId={session.clientId} />

      {groups.length === 0 ? (
        <Section title="Jobs" description="The individual pieces of work on your account.">
          <EmptyState icon={ListChecks}>Nothing listed yet. We will add the jobs here as they are planned.</EmptyState>
        </Section>
      ) : (
        groups.map((group) => {
          const { done, total } = progressOf(group.tasks);
          const label = PHASE_LABEL[group.phase] ?? group.phase;
          return (
            <Section key={group.phase} title={label}>
              <PortalProgress label={label} done={done} total={total} className="mb-4" />
              <DataList rows={group.tasks} columns={COLUMNS} getRowKey={(row) => row.id} caption={label} />
              <ProofChecklists
                items={group.tasks
                  .filter((task) => checklistByTask.has(task.id))
                  .map((task) => ({ id: task.id, title: task.title, checklist: checklistByTask.get(task.id) ?? [] }))}
              />
            </Section>
          );
        })
      )}
    </>
  );
}
