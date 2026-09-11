import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { BriefWriterAdapter } from "@launchos/integrations";
import { and, desc, eq, sql } from "drizzle-orm";
import { notifyOwner } from "../notifications/notify.js";

/**
 * The AI pass over a submitted brief.
 *
 * Runs after the submission is already committed and version one already
 * exists, so this can fail in every way a network call can and cost nothing but
 * a better document. That is the whole design: the model improves a brief, it
 * never produces one.
 *
 * Contact details do not go to the model. It is writing about a business, not
 * about a person, and a phone number in a prompt is a phone number in somebody
 * else's logs for no benefit at all.
 */

/** Answer keys held back from the model. */
const PRIVATE_KEYS = new Set(["name", "email", "phone", "addressLine1", "city", "postcode"]);

export function withoutContactDetails(answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (PRIVATE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * How many paid attempts a brief gets before the sweep stops offering it.
 *
 * The sweep runs every five minutes. Without a limit, a failure that repeats —
 * a schema mismatch, a model that refuses the prompt — is a paid call every
 * five minutes for ever, and it was: 109 in one day for one brief.
 */
export const MAX_BRIEF_WRITE_ATTEMPTS = 3;

export type WriteBriefResult =
  | { status: "written"; version: number }
  | { status: "skipped"; reason: "already_written" }
  | { status: "failed"; reason: string; attempts?: number; gaveUp?: boolean };

/**
 * Writes the next version of a brief, or reports why it could not.
 *
 * Never throws for a provider problem. The caller is a background job, and a
 * throw there produces a retry loop over something a retry will not fix — a bad
 * API key is not a transient condition. The failure is recorded where a person
 * will see it and the job moves on.
 */
export async function writeBriefVersion(
  db: Db,
  organisationId: string,
  submissionId: string,
  writer: BriefWriterAdapter,
): Promise<WriteBriefResult> {
  const [submission] = await db
    .select()
    .from(schema.briefSubmissions)
    .where(and(eq(schema.briefSubmissions.id, submissionId), eq(schema.briefSubmissions.organisationId, organisationId)));
  if (!submission) return { status: "failed", reason: "that submission could not be found" };

  const existing = await db
    .select()
    .from(schema.briefVersions)
    .where(eq(schema.briefVersions.submissionId, submissionId))
    .orderBy(desc(schema.briefVersions.version));

  // A worker that ran twice must not produce two version twos. The unique
  // index would catch it; checking first keeps a duplicate run cheap and quiet.
  if (existing.some((row) => row.generatorVersion !== "deterministic-1")) {
    return { status: "skipped", reason: "already_written" };
  }

  const nextVersion = (existing[0]?.version ?? 0) + 1;

  try {
    const written = await writer.write({
      answers: withoutContactDetails(submission.answers),
      reference: submission.reference,
    });

    await db.insert(schema.briefVersions).values({
      organisationId,
      submissionId,
      version: nextVersion,
      structured: written.structured as unknown as Record<string, unknown>,
      markdown: written.markdown,
      generatorVersion: `brief-writer-${writer.name}`,
      schemaVersion: "1",
      model: written.model,
    });

    return { status: "written", version: nextVersion };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = (Number(submission.metadata?.briefWriteAttempts) || 0) + 1;
    const gaveUp = attempts >= MAX_BRIEF_WRITE_ATTEMPTS;
    const now = new Date();

    // Bookkeeping on the submission, merged into its metadata in one statement
    // rather than read-modify-write. Telemetry about the writer, not a change to
    // the brief, so it is exempt from audit_log the way uptime checks are.
    const stamp = {
      briefWriteAttempts: attempts,
      briefWriteLastError: reason.slice(0, 500),
      briefWriteLastAttemptAt: now.toISOString(),
      ...(gaveUp ? { briefWriteGaveUpAt: now.toISOString() } : {}),
    };
    await db.update(schema.briefSubmissions)
      .set({
        metadata: sql`coalesce(${schema.briefSubmissions.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(schema.briefSubmissions.id, submissionId), eq(schema.briefSubmissions.organisationId, organisationId)));

    // Told once, when it stops trying. Version one is still there and still
    // true, so a failure is a "worth a look", not an emergency — and a bell on
    // every sweep is a bell people learn to ignore.
    if (gaveUp) {
      await notifyOwner(db, organisationId, {
        kind: "brief.write_failed",
        title: `The brief writer could not finish ${submission.reference}`,
        body: `Gave up after ${attempts} attempts: ${reason}. The submitted answers and the plain brief are safe.`,
        link: "/leads",
      }).catch(() => undefined);
    }
    return { status: "failed", reason, attempts, gaveUp };
  }
}

/**
 * Submissions still waiting on their written brief.
 *
 * Anything whose only version is the deterministic one. Reading the state from
 * the versions themselves rather than a status column means a crashed worker
 * leaves no half-claimed row behind — there is nothing to un-claim.
 */
export async function submissionsAwaitingBrief(
  db: Db,
  organisationId: string,
  limit = 10,
): Promise<{ id: string; reference: string }[]> {
  const submissions = await db
    .select({ id: schema.briefSubmissions.id, reference: schema.briefSubmissions.reference, metadata: schema.briefSubmissions.metadata })
    .from(schema.briefSubmissions)
    .where(eq(schema.briefSubmissions.organisationId, organisationId))
    .orderBy(desc(schema.briefSubmissions.submittedAt))
    .limit(200);

  const waiting: { id: string; reference: string }[] = [];
  for (const { metadata, ...submission } of submissions) {
    if (waiting.length >= limit) break;
    // Given up on: the owner has been told once, and another paid attempt at
    // the same failure is not going to be different.
    if (metadata?.briefWriteGaveUpAt) continue;
    const versions = await db
      .select({ generatorVersion: schema.briefVersions.generatorVersion })
      .from(schema.briefVersions)
      .where(eq(schema.briefVersions.submissionId, submission.id));
    if (versions.every((row) => row.generatorVersion === "deterministic-1")) waiting.push(submission);
  }
  return waiting;
}
