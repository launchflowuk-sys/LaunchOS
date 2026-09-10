import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { activeAnswers, canSubmit, excludedAnswerKeys } from "./questionnaire.js";
import { briefMarkdown } from "./brief-markdown.js";

/**
 * Sending the brief.
 *
 * One transaction does five things that must all be true together: the answers
 * are frozen, the submission exists, the draft is closed, the lead moves on,
 * and version one of the brief is written. A crash between any two of those is
 * the case that produces a customer who was told "received" and a staff screen
 * with nothing on it.
 *
 * The deterministic Markdown is written **here**, inside the same transaction,
 * before any model is involved. That ordering is the whole safety story: if the
 * AI is down, over quota, or returns something that fails its schema, there is
 * still a readable brief and the customer's submission was never at risk. The
 * model's version is an improvement on version one, never a prerequisite for it.
 */

export const SubmitInput = z.object({
  /** Same key on a retry — the unique index is what makes one press one submission. */
  idempotencyKey: z.string().min(8).max(200),
  expectedRevision: z.number().int().nonnegative(),
});
export type SubmitInput = z.input<typeof SubmitInput>;

export type SubmitResult =
  | { status: "submitted"; reference: string; submissionId: string; replayed: boolean }
  | { status: "incomplete"; errors: Record<string, string> };

/**
 * A reference the customer can quote.
 *
 * Random rather than sequential on purpose: `LF-000007` tells everyone who
 * receives one exactly how much work we have. The prefix and the dash are there
 * so it reads as a reference over the phone.
 */
function newReference(): string {
  // Crockford-ish: no I, O, U or L, so nothing is misread when it is spelled out.
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = randomBytes(8);
  const body = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `LF-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

export async function submitBrief(
  db: Db,
  organisationId: string,
  sessionId: string,
  input: SubmitInput,
): Promise<SubmitResult> {
  const v = SubmitInput.parse(input);

  const outcome = await db.transaction(async (tx) => {
    const inner = tx as unknown as Db;

    const [session] = await tx
      .select()
      .from(schema.briefSessions)
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)));
    if (!session) throw new Error("that draft could not be found");

    // A retry of a press that already landed. Looked up before anything else,
    // so a timeout on the customer's side costs them nothing.
    const [already] = await tx
      .select()
      .from(schema.briefSubmissions)
      .where(
        and(
          eq(schema.briefSubmissions.sessionId, sessionId),
          eq(schema.briefSubmissions.idempotencyKey, v.idempotencyKey),
        ),
      );
    if (already) {
      return {
        status: "submitted" as const,
        reference: already.reference,
        submissionId: already.id,
        replayed: true,
        leadId: session.leadId,
        business: String(session.answers.business ?? session.answers.name ?? "a new enquiry"),
      };
    }

    if (session.status === "submitted") throw new Error("that brief has already been sent");
    // Checked against the stored answers, not against anything the caller sent.
    const check = canSubmit(session.answers);
    if (!check.ok) return { status: "incomplete" as const, errors: check.errors };

    // Frozen, and scoped: a goal deselected on the way back takes its follow-up
    // answers out of the submitted requirements, though they stay in the draft.
    const frozen = activeAnswers(session.answers);
    const excluded = excludedAnswerKeys(session.answers);
    const reference = newReference();

    const [submission] = await tx
      .insert(schema.briefSubmissions)
      .values({
        organisationId,
        sessionId,
        submissionVersion: 1,
        answers: frozen,
        sourceRevision: session.revision,
        questionnaireVersion: session.questionnaireVersion,
        idempotencyKey: v.idempotencyKey,
        reference,
      })
      .returning();

    await tx.insert(schema.briefVersions).values({
      organisationId,
      submissionId: submission!.id,
      version: 1,
      markdown: briefMarkdown(frozen, { reference, excluded }),
      generatorVersion: "deterministic-1",
    });

    await tx
      .update(schema.briefSessions)
      .set({ status: "submitted", lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.briefSessions.id, sessionId));

    // The lead moves off "new" so it stops looking like an untouched enquiry.
    if (session.leadId) {
      await tx
        .update(schema.leads)
        .set({ status: "qualified", qualification: frozen, updatedAt: new Date() })
        .where(and(eq(schema.leads.id, session.leadId), eq(schema.leads.organisationId, organisationId)));
    }

    await recordAudit(inner, organisationId, {
      actorKind: "system",
      action: "brief.submitted",
      targetType: "brief_submission",
      targetId: submission!.id,
      after: { reference, questionnaireVersion: session.questionnaireVersion },
    });

    return {
      status: "submitted" as const,
      reference,
      submissionId: submission!.id,
      replayed: false,
      leadId: session.leadId,
      business: String(frozen.business ?? frozen.name ?? "a new enquiry"),
    };
  });

  if (outcome.status === "incomplete") return outcome;

  // Outside the transaction, and only on the first landing: the bell must never
  // be the reason a submitted brief rolls back, and a retry must not ring twice.
  if (!outcome.replayed) {
    await notifyOwner(db, organisationId, {
      kind: "brief.submitted",
      title: `Website brief in: ${outcome.business}`,
      body: `Reference ${outcome.reference}. Every answer is on the lead.`,
      link: outcome.leadId ? `/leads/${outcome.leadId}` : "/leads",
    }).catch(() => undefined);
  }

  return {
    status: "submitted",
    reference: outcome.reference,
    submissionId: outcome.submissionId,
    replayed: outcome.replayed,
  };
}
