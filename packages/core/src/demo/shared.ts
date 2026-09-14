import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * What every demo record has in common, and the one function that removes all
 * of it.
 *
 * There are three demo records, not one, because a single client can only ever
 * be at one point in the pipeline and the pipeline is the thing worth showing:
 *
 * | Record | What it demonstrates |
 * | --- | --- |
 * | Riverside Dental | delivered — the whole journey, in the past tense |
 * | Thameside Garage | mid-build — active phases, an overdue invoice, content waiting |
 * | Nadia Okonkwo | an open lead — a proposal sent and read, no decision yet |
 *
 * Between them every screen has something on it in a state a prospect can
 * recognise: progress bars part-way along, an approval waiting, money owed.
 * A delivered client alone leaves the in-progress half of the software looking
 * empty, which is the half that sells it.
 */

export const DEMO_PREFIX = "DEMO — ";
export const DEMO_SLUG_PREFIX = "demo-";
/** The handle that survives a half-finished run, when nothing else does. */
export const DEMO_REFERENCE_PREFIX = "LF-DEMO-";
/** The same, for proposals — a proposal on an open lead has no client to find it by. */
export const DEMO_PROPOSAL_PREFIX = "LF-P-DEMO-";

export interface DemoClientResult {
  clientId: string;
  leadId: string;
  projectId: string;
  reference: string;
  /** What was created, for the log. */
  created: Record<string, number>;
}

/** A counter that reads as a sentence at the call site. */
export function counter(): { created: Record<string, number>; count: (key: string) => void } {
  const created: Record<string, number> = {};
  return { created, count: (key: string) => { created[key] = (created[key] ?? 0) + 1; } };
}

/** Days ago, as a date. A negative number is in the future. */
export function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * The same instant as `YYYY-MM-DD`.
 *
 * `proposals.valid_until` and `projects.target_date` are `date` columns, not
 * timestamps, so Drizzle types them as strings. Passing a `Date` typechecks
 * nowhere and is the sort of thing that only shows up at the insert.
 */
export function dayOnly(days: number, now: Date): string {
  return daysAgo(days, now).toISOString().slice(0, 10);
}

/** The calendar month content is filed under. */
export function periodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Removes every demo record and everything hanging off it.
 *
 * Hard deletes rather than soft: a demo has no audit value and a soft-deleted
 * one would sit in the tables for ever, turning up in any count that forgets
 * its `deleted_at` filter. Children before parents, because the foreign keys
 * are `restrict` in places.
 *
 * Three things are found by prefix rather than by parent, and each for a
 * reason learned the hard way:
 *
 *  - **Brief submissions, by reference.** The chain hangs off the lead, which
 *    is why the first version missed it and re-running failed on
 *    `brief_submissions_reference`. Keying off the lead was not enough either:
 *    deleting a lead sets the session's `lead_id` to null, so a half-finished
 *    run leaves a submission that no lead points at and nothing can find.
 *  - **Proposals, by reference.** A proposal on an open lead has no
 *    `client_id`, so a client-scoped delete cannot see it.
 *  - **Clients, by slug — plural.** This used to take the first row it found,
 *    which was correct while there was one demo client and quietly left the
 *    others behind the moment there were three.
 */
export async function removeDemoClients(db: Db, organisationId: string): Promise<{ removed: number }> {
  const demoSubmissions = await db
    .select({ id: schema.briefSubmissions.id, sessionId: schema.briefSubmissions.sessionId })
    .from(schema.briefSubmissions)
    .where(
      and(
        eq(schema.briefSubmissions.organisationId, organisationId),
        like(schema.briefSubmissions.reference, `${DEMO_REFERENCE_PREFIX}%`),
      ),
    );

  if (demoSubmissions.length > 0) {
    const submissionIds = demoSubmissions.map((row) => row.id);
    const sessionIds = [...new Set(demoSubmissions.map((row) => row.sessionId))];
    await db.delete(schema.briefVersions).where(inArray(schema.briefVersions.submissionId, submissionIds));
    await db.delete(schema.briefSubmissions).where(inArray(schema.briefSubmissions.id, submissionIds));
    await db.delete(schema.briefMutations).where(inArray(schema.briefMutations.sessionId, sessionIds));
    await db.delete(schema.briefSessions).where(inArray(schema.briefSessions.id, sessionIds));
  }

  const clients = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), like(schema.clients.slug, `${DEMO_SLUG_PREFIX}%`)));
  const clientIds = clients.map((row) => row.id);

  // Before the clients, because `proposals.client_id` is `set null` and a
  // nulled row would then only be reachable by its reference.
  await db
    .delete(schema.proposals)
    .where(and(eq(schema.proposals.organisationId, organisationId), like(schema.proposals.reference, `${DEMO_PROPOSAL_PREFIX}%`)));

  if (clientIds.length > 0) {
    await db.delete(schema.contentItems).where(and(eq(schema.contentItems.organisationId, organisationId), inArray(schema.contentItems.clientId, clientIds)));
    await db.delete(schema.contentBriefs).where(and(eq(schema.contentBriefs.organisationId, organisationId), inArray(schema.contentBriefs.clientId, clientIds)));
    await db.delete(schema.contentChannels).where(and(eq(schema.contentChannels.organisationId, organisationId), inArray(schema.contentChannels.clientId, clientIds)));
    await db.delete(schema.projectMilestones).where(and(eq(schema.projectMilestones.organisationId, organisationId), inArray(schema.projectMilestones.clientId, clientIds)));
    await db.delete(schema.projectPhases).where(and(eq(schema.projectPhases.organisationId, organisationId), inArray(schema.projectPhases.clientId, clientIds)));
    await db.delete(schema.projects).where(and(eq(schema.projects.organisationId, organisationId), inArray(schema.projects.clientId, clientIds)));
    await db.delete(schema.invoices).where(and(eq(schema.invoices.organisationId, organisationId), inArray(schema.invoices.clientId, clientIds)));
    await db.delete(schema.subscriptions).where(and(eq(schema.subscriptions.organisationId, organisationId), inArray(schema.subscriptions.clientId, clientIds)));
    await db.delete(schema.domains).where(and(eq(schema.domains.organisationId, organisationId), inArray(schema.domains.clientId, clientIds)));
    await db.delete(schema.sites).where(and(eq(schema.sites.organisationId, organisationId), inArray(schema.sites.clientId, clientIds)));
    await db.delete(schema.activityEvents).where(and(eq(schema.activityEvents.organisationId, organisationId), inArray(schema.activityEvents.clientId, clientIds)));
    await db.delete(schema.clients).where(and(eq(schema.clients.organisationId, organisationId), inArray(schema.clients.id, clientIds)));
  }

  // Last, and by name: a lead may exist without a client either because a
  // previous run half-failed or because it is the open one, which never had
  // one by design.
  await db
    .delete(schema.leads)
    .where(and(eq(schema.leads.organisationId, organisationId), like(schema.leads.name, `${DEMO_PREFIX}%`)));

  return { removed: clientIds.length };
}
