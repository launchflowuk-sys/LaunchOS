import { schema } from "@launchos/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";

/**
 * The Friday update, on the page.
 *
 * Shoji sends a short note every Friday about each active build. This is the
 * same news, standing on the page the rest of the week, built from the record
 * rather than from the email: the steps that finished and the promises that
 * were kept in the last seven days. Reading it off the project itself means
 * the page and the note cannot disagree, and a week where nothing moved says
 * so instead of quietly showing last week's paragraph again.
 *
 * Seven days rather than "since Friday" because a client opens this on a
 * Tuesday as often as a Monday, and a window that empties on Saturday morning
 * would show them nothing on the two days they are most likely to look.
 */

const WINDOW_DAYS = 7;

type Moment = { id: string; at: Date; text: string };

export async function WeeklyUpdate({ organisationId, clientId }: { organisationId: string; clientId: string }) {
  const db = getDb();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS);

  // Both reads are scoped by organisation and client, and the milestone read
  // also by `client_visible` — an internal promise is not news for this page.
  const [phases, milestones] = await Promise.all([
    db
      .select({ id: schema.projectPhases.id, name: schema.projectPhases.name, doneAt: schema.projectPhases.doneAt, project: schema.projects.name })
      .from(schema.projectPhases)
      .innerJoin(schema.projects, eq(schema.projectPhases.projectId, schema.projects.id))
      .where(and(
        eq(schema.projectPhases.organisationId, organisationId),
        eq(schema.projectPhases.clientId, clientId),
        eq(schema.projectPhases.status, "done"),
        gte(schema.projectPhases.doneAt, since),
        isNull(schema.projectPhases.deletedAt),
      ))
      .orderBy(desc(schema.projectPhases.doneAt)),
    db
      .select({ id: schema.projectMilestones.id, title: schema.projectMilestones.title, reachedAt: schema.projectMilestones.reachedAt })
      .from(schema.projectMilestones)
      .where(and(
        eq(schema.projectMilestones.organisationId, organisationId),
        eq(schema.projectMilestones.clientId, clientId),
        eq(schema.projectMilestones.clientVisible, true),
        gte(schema.projectMilestones.reachedAt, since),
        isNull(schema.projectMilestones.deletedAt),
      ))
      .orderBy(desc(schema.projectMilestones.reachedAt)),
  ]);

  const moments: Moment[] = [
    ...phases.filter((row) => row.doneAt !== null).map((row) => ({ id: row.id, at: row.doneAt!, text: `${row.name} finished on ${row.project}.` })),
    ...milestones.filter((row) => row.reachedAt !== null).map((row) => ({ id: row.id, at: row.reachedAt!, text: row.title })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <Section
      title="This week"
      description="What moved in the last seven days. We send the same note by email every Friday."
    >
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        {moments.length === 0 ? (
          <p className="text-base text-muted-foreground">
            Nothing finished this week. Quiet weeks happen — the work above is where things stand, and Friday&rsquo;s note will
            say the same. If you would like to talk it through, raise a request and we will come back to you.
          </p>
        ) : (
          <ul className="grid gap-3">
            {moments.map((moment) => (
              <li key={moment.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <p className="min-w-0 text-base break-words">{moment.text}</p>
                <p className="shrink-0 text-meta text-muted-foreground">{formatDate(moment.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
