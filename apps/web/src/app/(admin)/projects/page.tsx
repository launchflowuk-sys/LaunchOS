import { listClients, listProjects, projectProgress, type ProjectRow } from "@launchos/core";
import { schema } from "@launchos/db";
import type { ProjectStatus } from "@launchos/db/schema";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { HardHat } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { NewProjectForm } from "./new-project-form";
import { ProjectStatusBadge } from "./project-status-badge";
import { PROJECT_STATUS_LABEL, PROJECT_STATUSES } from "./schemas";

export const dynamic = "force-dynamic";

const FILTERS = ["all", ...PROJECT_STATUSES] as const;
type Filter = (typeof FILTERS)[number];

type Row = { project: ProjectRow; clientName: string | null; percent: number };

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "name",
    header: "Project",
    primary: true,
    cell: ({ project, clientName }) => (
      <>
        <Link href={`/projects/${project.id}`} className="hover:underline">
          {project.name}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">{clientName ?? "—"}</span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: ({ project }) => <ProjectStatusBadge status={project.status} /> },
  {
    key: "progress",
    header: "Progress",
    numeric: true,
    // The bar belongs on the detail page and the client's; a list wants the
    // one number, and the sentence that defends it is a click away.
    cell: ({ percent }) => `${percent}%`,
  },
  {
    key: "target",
    header: "Target",
    className: "whitespace-nowrap",
    cell: ({ project }) => (project.targetDate ? formatDate(`${project.targetDate}T12:00:00Z`) : "No date set"),
  },
  {
    key: "delivered",
    header: "Delivered",
    hideOnMobile: true,
    className: "whitespace-nowrap",
    cell: ({ project }) => (project.deliveredAt ? formatDate(project.deliveredAt) : "—"),
  },
];

/** How many projects sit in each status, for the filter row under the header. */
async function countsByStatus(organisationId: string): Promise<Record<ProjectStatus, number>> {
  const rows = await getDb()
    .select({ status: schema.projects.status, value: count() })
    .from(schema.projects)
    .where(and(eq(schema.projects.organisationId, organisationId), isNull(schema.projects.deletedAt)))
    .groupBy(schema.projects.status);
  const counts: Record<ProjectStatus, number> = { planned: 0, active: 0, on_hold: 0, delivered: 0, cancelled: 0 };
  for (const row of rows) counts[row.status] = row.value;
  return counts;
}

/**
 * The progress figure for a page of projects, in two grouped reads rather than
 * two per row. `getProject` is the four-statement read for one screen; a list
 * of fifty would be two hundred, so the same arithmetic is done here from two
 * `IN` queries and `projectProgress` — the one function that decides the rule.
 */
async function progressFor(organisationId: string, projects: readonly ProjectRow[]): Promise<Map<string, number>> {
  if (projects.length === 0) return new Map();
  const ids = projects.map((project) => project.id);
  const db = getDb();
  const [phases, milestones] = await Promise.all([
    db
      .select({ projectId: schema.projectPhases.projectId, status: schema.projectPhases.status })
      .from(schema.projectPhases)
      .where(and(
        eq(schema.projectPhases.organisationId, organisationId),
        inArray(schema.projectPhases.projectId, ids),
        isNull(schema.projectPhases.deletedAt),
      )),
    db
      .select({ projectId: schema.projectMilestones.projectId, reachedAt: schema.projectMilestones.reachedAt })
      .from(schema.projectMilestones)
      .where(and(
        eq(schema.projectMilestones.organisationId, organisationId),
        inArray(schema.projectMilestones.projectId, ids),
        isNull(schema.projectMilestones.deletedAt),
      )),
  ]);

  const out = new Map<string, number>();
  for (const project of projects) {
    const progress = projectProgress({
      status: project.status,
      deliveredAt: project.deliveredAt,
      phases: phases.filter((phase) => phase.projectId === project.id),
      milestones: milestones.filter((milestone) => milestone.projectId === project.id),
    });
    out.set(project.id, progress.percent);
  }
  return out;
}

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status : "all";
  const filter: Filter = FILTERS.includes(statusParam as Filter) ? (statusParam as Filter) : "all";

  const [projects, counts, clients] = await Promise.all([
    listProjects(getDb(), session.organisationId, { ...(filter === "all" ? {} : { status: filter }), limit: 200 }),
    countsByStatus(session.organisationId),
    listClients(getDb(), session.organisationId, { status: "active" }),
  ]);
  const percentById = await progressFor(session.organisationId, projects);
  const clientNameById = new Map(clients.map((client) => [client.id, client.name]));
  const rows: Row[] = projects.map((project) => ({
    project,
    clientName: clientNameById.get(project.clientId) ?? null,
    percent: percentById.get(project.id) ?? 0,
  }));

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every build we have on. A project gives a client one honest progress page and gives us one place to see the work."
        category="delivery"
      />

      {/* The counts are the page's one number: what is on, what is waiting and
          what has landed. Links rather than pills so a tap filters. */}
      <ul className="mb-4 flex flex-wrap gap-2" aria-label="Projects by status">
        {PROJECT_STATUSES.map((status) => (
          <li key={status}>
            <Link
              href={{ pathname: "/projects", query: { status } }}
              aria-current={filter === status ? "page" : undefined}
              className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-primary-soft"
            >
              <span>{PROJECT_STATUS_LABEL[status]}</span>
              <span className="font-semibold tabular-nums">{counts[status]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <form action="/projects">
        <FilterBar>
          <ToolbarField label="Status" htmlFor="status" className="sm:w-52">
            <NativeSelect id="status" name="status" defaultValue={filter}>
              {FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All" : PROJECT_STATUS_LABEL[option]}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={({ project }) => project.id}
        caption="Projects"
        empty={
          <EmptyState icon={HardHat}>
            {filter === "all"
              ? "No projects yet. Accepting a proposal starts one, or start one below for work agreed another way."
              : `No ${PROJECT_STATUS_LABEL[filter].toLowerCase()} projects.`}
          </EmptyState>
        }
      />

      {clients.length > 0 ? (
        <Section
          title="Start a project"
          description="For work agreed on a call. An accepted proposal starts its own, with the deliverables already written in as milestones."
        >
          <div className="rounded-xl border bg-card p-4">
            <NewProjectForm clients={clients.map((client) => ({ id: client.id, name: client.name }))} />
          </div>
        </Section>
      ) : null}
    </>
  );
}
