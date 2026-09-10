import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";

/**
 * Reading a lead's website brief back out.
 *
 * The newest version wins, and which generator wrote it is part of the answer —
 * a brief written from the answers alone and one a model has been over are both
 * legitimate, but a person reading it needs to know which they have. A staff
 * screen that presents them identically is one where nobody notices the AI has
 * been failing for a week.
 */

export interface LeadBrief {
  submissionId: string;
  reference: string;
  submittedAt: Date;
  /** The draft's revision when the snapshot was frozen. */
  sourceRevision: number;
  answers: Record<string, unknown>;
  version: number;
  markdown: string;
  structured: Record<string, unknown> | null;
  /** `deterministic-1` or `brief-writer-<adapter>`. */
  generatorVersion: string;
  model: string | null;
  /** True while only the plain version exists — the AI pass has not landed. */
  awaitingWriter: boolean;
}

/**
 * The brief behind a lead, or null.
 *
 * Goes lead → session → submission → newest version, because the lead is what
 * every other screen already has in its hand. A lead with no funnel session, or
 * a session still being filled in, gives null rather than an empty shell.
 */
export async function briefForLead(db: Db, organisationId: string, leadId: string): Promise<LeadBrief | null> {
  const [session] = await db
    .select({ id: schema.briefSessions.id })
    .from(schema.briefSessions)
    .where(and(eq(schema.briefSessions.organisationId, organisationId), eq(schema.briefSessions.leadId, leadId)));
  if (!session) return null;

  const [submission] = await db
    .select()
    .from(schema.briefSubmissions)
    .where(
      and(
        eq(schema.briefSubmissions.organisationId, organisationId),
        eq(schema.briefSubmissions.sessionId, session.id),
      ),
    )
    .orderBy(desc(schema.briefSubmissions.submissionVersion));
  if (!submission) return null;

  const versions = await db
    .select()
    .from(schema.briefVersions)
    .where(eq(schema.briefVersions.submissionId, submission.id))
    .orderBy(desc(schema.briefVersions.version));
  const newest = versions[0];
  if (!newest) return null;

  return {
    submissionId: submission.id,
    reference: submission.reference,
    submittedAt: submission.submittedAt,
    sourceRevision: submission.sourceRevision,
    answers: submission.answers,
    version: newest.version,
    markdown: newest.markdown,
    structured: newest.structured,
    generatorVersion: newest.generatorVersion,
    model: newest.model,
    awaitingWriter: versions.every((row) => row.generatorVersion === "deterministic-1"),
  };
}

/**
 * How far somebody got who has not sent anything yet.
 *
 * The other half of the picture: a lead with a draft behind it is a person who
 * started and stopped, and knowing they reached stage six before going quiet is
 * the difference between a cold call and a useful one.
 */
export interface LeadDraftProgress {
  currentStep: number;
  completedSteps: number[];
  lastActivityAt: Date;
  answers: Record<string, unknown>;
}

export async function draftProgressForLead(
  db: Db,
  organisationId: string,
  leadId: string,
): Promise<LeadDraftProgress | null> {
  const [session] = await db
    .select()
    .from(schema.briefSessions)
    .where(and(eq(schema.briefSessions.organisationId, organisationId), eq(schema.briefSessions.leadId, leadId)));
  if (!session || session.status !== "draft") return null;
  return {
    currentStep: session.currentStep,
    completedSteps: session.completedSteps,
    lastActivityAt: session.lastActivityAt,
    answers: session.answers,
  };
}
