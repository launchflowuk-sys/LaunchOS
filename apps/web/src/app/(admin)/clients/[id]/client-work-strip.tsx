import { listCaseStudies, listProjects, projectProgress } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { CaseStudyStatusBadge } from "../../case-studies/case-study-status-badge";
import { ProjectStatusBadge } from "../../projects/project-status-badge";

/**
 * What we are building for this client, and the story it will become.
 *
 * On the Overview tab rather than a tab of its own because it is two or three
 * rows for most clients, and because the question it answers — "where is their
 * build up to, and is their story out yet?" — is the one Shoji has on the
 * client's page rather than on the Projects list.
 *
 * Renders nothing when a client has neither, so an old client whose work
 * predates projects does not get an empty heading.
 */
export async function ClientWorkStrip({ organisationId, clientId }: { organisationId: string; clientId: string }) {
  const db = getDb();
  const [projects, studies] = await Promise.all([
    listProjects(db, organisationId, { clientId, limit: 20 }),
    listCaseStudies(db, organisationId, { clientId, limit: 20 }),
  ]);
  if (projects.length === 0 && studies.length === 0) return null;

  // The progress figures for the strip, in two grouped reads rather than two
  // per project. `projectProgress` is the only thing allowed to turn them into
  // a percentage.
  const ids = projects.map((project) => project.id);
  const [phases, milestones] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
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

  return (
    <Section title="Builds and their story" description="What we are building for them, and where the public case study has got to.">
      <ul className="grid gap-3">
        {projects.map((project) => {
          const progress = projectProgress({
            status: project.status,
            deliveredAt: project.deliveredAt,
            phases: phases.filter((phase) => phase.projectId === project.id),
            milestones: milestones.filter((milestone) => milestone.projectId === project.id),
          });
          return (
            <li key={project.id} className="min-w-0 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <Link href={`/projects/${project.id}`} className="text-sm font-medium hover:underline">
                    {project.name}
                  </Link>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {project.deliveredAt
                      ? `Delivered ${formatDate(project.deliveredAt)}`
                      : project.targetDate
                        ? `Target ${formatDate(`${project.targetDate}T12:00:00Z`)}`
                        : "No target date"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums text-category-delivery">{progress.percent}%</span>
                  <ProjectStatusBadge status={project.status} />
                </div>
              </div>
            </li>
          );
        })}

        {studies.map((study) => (
          <li key={study.id} className="min-w-0 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <Link href={`/case-studies/${study.id}`} className="text-sm font-medium hover:underline">
                  {study.name}
                </Link>
                <p className="mt-0.5 text-meta text-muted-foreground">
                  Case study · {study.status === "published" ? `live at /work/${study.slug}` : `/work/${study.slug} when it goes up`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {study.featured ? <StatusBadge value="featured" tone="info" label="Home page" /> : null}
                <CaseStudyStatusBadge status={study.status} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
