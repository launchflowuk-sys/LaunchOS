import { describeProgress, getCaseStudyForProject, getClient, getProject, UNPHASED } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { SquareCheckBig } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { KeyValue } from "@/components/key-value";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ProgressPanel } from "../progress-panel";
import { ProjectStatusBadge } from "../project-status-badge";
import { HandoverPanel } from "./handover-panel";
import { MilestoneList } from "./milestone-list";
import { PhaseSpine } from "./phase-spine";
import { DeliverProjectForm, ProjectDetailsForm } from "./project-forms";

export const dynamic = "force-dynamic";

type LinkedTask = { id: string; title: string; status: string; phaseId: string | null; dueAt: Date | null };

/** The tasks written against this project, in one read scoped by organisation. */
async function linkedTasks(organisationId: string, projectId: string): Promise<LinkedTask[]> {
  return getDb()
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      phaseId: schema.tasks.phaseId,
      dueAt: schema.tasks.dueAt,
    })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      eq(schema.tasks.projectId, projectId),
      isNull(schema.tasks.deletedAt),
    ))
    .orderBy(asc(schema.tasks.dueAt), asc(schema.tasks.createdAt));
}

export default async function ProjectDetailPage({ params }: PageProps<"/projects/[id]">) {
  const id = uuidOr404((await params).id);
  const session = await requireAdmin();
  const db = getDb();

  // One read for the whole screen: the project, its spine, every milestone and
  // the task counts per phase, in four statements. Nothing below may query
  // again per phase — `tasksByPhase` is what that would ask for.
  const detail = await getProject(db, session.organisationId, id);
  if (!detail) notFound();
  const { project, phases, milestones, tasks, tasksByPhase, progress } = detail;

  const [client, caseStudy, taskRows] = await Promise.all([
    getClient(db, session.organisationId, project.clientId),
    getCaseStudyForProject(db, session.organisationId, project.id),
    linkedTasks(session.organisationId, project.id),
  ]);

  const phaseName = new Map(phases.map((phase) => [phase.id, phase.name]));
  const TASK_COLUMNS: readonly DataListColumn<LinkedTask>[] = [
    {
      key: "title",
      header: "Task",
      primary: true,
      cell: (row) => (
        <Link href={`/tasks/${row.id}`} className="hover:underline">
          {row.title}
        </Link>
      ),
    },
    { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
    { key: "phase", header: "Step", cell: (row) => phaseName.get(row.phaseId ?? "") ?? "No step" },
    { key: "due", header: "Due", className: "whitespace-nowrap", cell: (row) => (row.dueAt ? formatDate(row.dueAt) : "No date set") },
  ];

  const outstanding =
    phases.filter((phase) => phase.status !== "done" && phase.status !== "skipped").length +
    milestones.filter((milestone) => milestone.reachedAt === null).length;
  const unphased = tasksByPhase[UNPHASED];

  return (
    <>
      <PageHeader
        title={project.name}
        description={client ? `${client.name} · ${project.summary ?? "no summary yet"}` : (project.summary ?? "")}
        category="delivery"
        actions={<ProjectStatusBadge status={project.status} />}
      />

      <ProgressPanel progress={progress} description={describeProgress(progress)} className="mb-6" />

      <Section title="Details" description="The facts on the record. Delivery is its own decision, at the bottom of this page.">
        <div className="rounded-xl border bg-card p-4">
          <ProjectDetailsForm
            projectId={project.id}
            defaults={{
              name: project.name,
              summary: project.summary ?? "",
              status: project.status,
              targetDate: project.targetDate ?? "",
            }}
          />
        </div>
        <KeyValue
          className="mt-4"
          columns={2}
          items={[
            {
              label: "Client",
              value: client ? <Link href={`/clients/${client.id}`} className="hover:underline">{client.name}</Link> : "—",
            },
            {
              label: "From a proposal",
              value: project.proposalId ? (
                <Link href={`/proposals/${project.proposalId}`} className="hover:underline">
                  See the proposal
                </Link>
              ) : (
                "Agreed another way"
              ),
            },
            { label: "Started", value: project.startedAt ? formatDate(project.startedAt) : "Not started" },
            { label: "Delivered", value: project.deliveredAt ? formatDate(project.deliveredAt) : "Not yet" },
            {
              label: "Case study",
              value: caseStudy ? (
                <Link href={`/case-studies/${caseStudy.id}`} className="hover:underline">
                  {caseStudy.name}
                </Link>
              ) : (
                "None started"
              ),
              ...(caseStudy ? { hint: `${caseStudy.status} · ${caseStudy.deliveryStatus}` } : {}),
            },
          ]}
        />
      </Section>

      <Section title="The plan" description="Six steps as standard. Any of them can be marked not needed — a client who brought their own design has no design step.">
        <PhaseSpine projectId={project.id} clientId={project.clientId} phases={phases} tasksByPhase={tasksByPhase} />
      </Section>

      <Section
        title="Milestones"
        description="What we promised, in the client's words. Marking one reached emails them the same day, once."
      >
        <MilestoneList projectId={project.id} milestones={milestones} phases={phases} />
      </Section>

      <Section
        title="Linked tasks"
        description={
          tasks.total === 0
            ? "No tasks are written against this project yet."
            : `${tasks.done} of ${tasks.total} done${unphased && unphased.total > 0 ? `, ${unphased.total} with no step set` : ""}.`
        }
      >
        <DataList
          rows={taskRows}
          columns={TASK_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Linked tasks"
          empty={
            <EmptyState icon={SquareCheckBig}>
              Nothing linked yet. Most work for a client is not on a build — onboarding, care and support are tasks without a project.
            </EmptyState>
          }
        />
      </Section>

      {/* The handover before Deliver, because that is the order it happens in:
          the report goes out, the client signs it off, and signing off is what
          closes the project. Closing it by hand below is the other door — for
          a build that was handed over in person. */}
      <Section
        title="Handover"
        description="What we built, where it lives, where their logins are kept and what the care plan covers — compiled from this project, not typed. Signing it off closes the project and starts the care plan."
      >
        <HandoverPanel organisationId={session.organisationId} projectId={project.id} />
      </Section>

      {project.deliveredAt ? null : (
        <Section title="Deliver by hand" description="Closing it here does everything sign-off does, for a build that was handed over in person. It is what puts the client's page at 100%, and it opens their case study for writing.">
          <div className="rounded-xl border bg-card p-4">
            <DeliverProjectForm projectId={project.id} outstanding={outstanding} />
          </div>
        </Section>
      )}
    </>
  );
}
