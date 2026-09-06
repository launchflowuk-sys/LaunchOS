import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { FunnelAnswer, FunnelStep } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { LeadAttributionSchema } from "../leads/attribution.js";
import { createLead } from "../leads/leads.js";
import { FunnelRefused, type FunnelRow } from "./crud.js";
import { maximumScore } from "./steps.js";

export type FunnelSessionRow = typeof schema.funnelSessions.$inferSelect;

/** The bell (and the phone buzz) a funnel raises when somebody scores well. */
export const FUNNEL_HOT_NOTIFICATION_KIND = "funnel.hot_lead";

/** Where the "we already buzzed about this one" stamp lives on the session. */
const HOT_NOTIFIED_KEY = "hotNotifiedAt";

/**
 * A visitor walking a funnel.
 *
 * The row is written on the **first** answer, not on submit, and the lead is
 * created the moment the contact step is answered — long before
 * `completed_at`. That is the whole design: a funnel that only produced a lead
 * at the end would be a contact form with five screens of friction in front of
 * it, and would throw away the visitor who taps twice, gives a number and then
 * gets distracted.
 *
 * Audit follows the milestones rather than the taps: `funnel.session_started`,
 * `funnel.contact_captured` and `funnel.completed` are business facts and are
 * recorded; the individual answer writes between them are the session's own
 * state and are exempt in the same way `uptime_checks` are (CLAUDE.md rule 3).
 * The lead the contact step creates is audited by `createLead` itself.
 */

/** 32 hex characters. Unguessable, and never leaves the visitor's tab. */
function mintSessionToken(): string {
  return randomBytes(16).toString("hex");
}

const Token = z.string().trim().regex(/^[a-f0-9]{32}$/, "that funnel session is not one we recognise");

const ContactAnswer = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  phone: z.string().trim().min(4, "Enter a phone number we can reach you on").max(40),
  email: z.string().trim().max(320).email("Enter a full email address").optional(),
  business: z.string().trim().max(200).optional(),
});

export const AnswerFunnelStepInput = z.object({
  funnelId: z.string().uuid(),
  /** Absent on the first answer, which is what mints the session. */
  token: Token.optional(),
  stepKey: z.string().trim().min(1).max(60),
  /** A `choice` step: the option's value. */
  choice: z.string().trim().max(60).optional(),
  /** A `text` step. */
  text: z.string().trim().max(2000).optional(),
  /** A `contact` step. */
  contact: ContactAnswer.optional(),
  /** Carried on the first answer only; later answers do not restate it. */
  attribution: LeadAttributionSchema.optional(),
});
export type AnswerFunnelStepInput = z.input<typeof AnswerFunnelStepInput>;

export interface AnswerFunnelStepResult {
  session: FunnelSessionRow;
  /** The visitor's token, to send with the next answer. */
  token: string;
  /** Set from the contact step onwards. */
  leadId: string | null;
}

/**
 * Records one answer, creating the session on the first and the lead on the
 * contact step. Idempotent per step: answering the same step again overwrites
 * that answer and re-scores, so a visitor stepping back does not double-count.
 */
export async function answerFunnelStep(
  db: Db,
  organisationId: string,
  input: AnswerFunnelStepInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnswerFunnelStepResult> {
  const v = AnswerFunnelStepInput.parse(input);
  const funnel = await loadPublishedFunnel(db, organisationId, v.funnelId);
  const step = funnel.steps.find((candidate) => candidate.key === v.stepKey);
  if (!step) throw new FunnelRefused("not_found", "That question is not part of this funnel any more.");

  const existing = v.token ? await sessionByToken(db, organisationId, v.token) : null;
  if (v.token && !existing) throw new FunnelRefused("not_found", "That funnel session is not one we recognise.");
  if (existing && existing.funnelId !== funnel.id) throw new FunnelRefused("not_found", "That funnel session belongs to another funnel.");

  const answer = answerFor(step, v);
  const session = existing ?? (await startSession(db, organisationId, funnel, v.attribution));
  const answers: Record<string, FunnelAnswer> = { ...session.answers, [step.key]: answer };
  const score = scoreOf(funnel.steps, answers);

  const [updated] = await db.update(schema.funnelSessions)
    .set({ answers, score, answered: Object.keys(answers).length, updatedAt: new Date() })
    .where(and(eq(schema.funnelSessions.id, session.id), eq(schema.funnelSessions.organisationId, organisationId)))
    .returning();

  if (step.kind === "contact" && !updated!.leadId) {
    const withLead = await captureContact(db, organisationId, funnel, updated!, v.contact!, env);
    await maybeBuzz(db, organisationId, funnel, withLead);
    return { session: withLead, token: withLead.token, leadId: withLead.leadId };
  }
  await maybeBuzz(db, organisationId, funnel, updated!);
  return { session: updated!, token: updated!.token, leadId: updated!.leadId };
}

export const CompleteFunnelSessionInput = z.object({ funnelId: z.string().uuid(), token: Token });
export type CompleteFunnelSessionInput = z.input<typeof CompleteFunnelSessionInput>;

/**
 * The last screen. Stamps the session, rewrites the lead's message so every
 * answer is on the record Shoji reads, and is a no-op on a session already
 * completed — the "done" page reloads.
 */
export async function completeFunnelSession(db: Db, organisationId: string, input: CompleteFunnelSessionInput): Promise<FunnelSessionRow> {
  const v = CompleteFunnelSessionInput.parse(input);
  const funnel = await loadPublishedFunnel(db, organisationId, v.funnelId);
  const session = await sessionByToken(db, organisationId, v.token);
  if (!session || session.funnelId !== funnel.id) throw new FunnelRefused("not_found", "That funnel session is not one we recognise.");
  if (session.completedAt) return session;

  const now = new Date();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.funnelSessions)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(and(eq(schema.funnelSessions.id, session.id), eq(schema.funnelSessions.organisationId, organisationId)))
      .returning();
    if (after!.leadId) await refreshLeadMessage(tx, organisationId, funnel, after!);
    await recordAudit(tx, organisationId, {
      actorKind: "client", action: "funnel.completed", targetType: "funnel_session", targetId: session.id, before: session, after,
    });
    return after!;
  });
}

/** The session behind a token, scoped to the organisation the caller resolved. */
export async function sessionByToken(db: Db, organisationId: string, token: string): Promise<FunnelSessionRow | null> {
  const parsed = Token.safeParse(token);
  if (!parsed.success) return null;
  const [row] = await db.select().from(schema.funnelSessions)
    .where(and(eq(schema.funnelSessions.token, parsed.data), eq(schema.funnelSessions.organisationId, organisationId)));
  return row ?? null;
}

async function loadPublishedFunnel(db: Db, organisationId: string, funnelId: string): Promise<FunnelRow> {
  const [row] = await db.select().from(schema.funnels)
    .where(and(eq(schema.funnels.id, funnelId), eq(schema.funnels.organisationId, organisationId)));
  if (!row || row.deletedAt) throw new FunnelRefused("not_found", "That funnel is not one of ours.");
  if (row.status !== "published") throw new FunnelRefused("not_published", "This funnel is not taking answers at the moment.");
  return row;
}

/** Validates the answer against the step it claims to answer, and scores it. */
function answerFor(step: FunnelStep, v: z.output<typeof AnswerFunnelStepInput>): FunnelAnswer {
  if (step.kind === "choice") {
    const option = (step.options ?? []).find((candidate) => candidate.value === v.choice);
    if (!option) throw new FunnelRefused("not_found", "Pick one of the answers shown.");
    return { value: option.value, label: option.label, points: option.points };
  }
  if (step.kind === "text") {
    const text = v.text ?? "";
    if (step.required && text.length === 0) throw new FunnelRefused("not_found", "Please answer this one before moving on.");
    return { value: text, label: text, points: 0 };
  }
  const contact = ContactAnswer.parse(v.contact ?? {});
  if (step.contact?.emailRequired && !contact.email) throw new FunnelRefused("not_found", "Enter an email address so we can write back.");
  return { value: contact.phone, label: contact.name, points: 0 };
}

function scoreOf(steps: readonly FunnelStep[], answers: Record<string, FunnelAnswer>): number {
  return steps.reduce((total, step) => total + (answers[step.key]?.points ?? 0), 0);
}

async function startSession(db: Db, organisationId: string, funnel: FunnelRow, attribution: z.output<typeof LeadAttributionSchema> | undefined): Promise<FunnelSessionRow> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.funnelSessions).values({
      organisationId,
      funnelId: funnel.id,
      token: mintSessionToken(),
      // The attribution rides on the session until the contact step turns it
      // into a lead, so a visitor who never reaches that step still tells us
      // which campaign paid for the click that produced nothing.
      metadata: attribution ? { attribution } : {},
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: "client", action: "funnel.session_started", targetType: "funnel_session", targetId: row!.id, after: row,
    });
    return row!;
  });
}

/**
 * The middle screen: a real lead, through `createLead` like every other
 * source. Nothing here is a second lead path — the acknowledgement email, the
 * Lead Qualifier and the booking link all hang off that one function, and a
 * funnel lead gets all three for free.
 */
async function captureContact(
  db: Db,
  organisationId: string,
  funnel: FunnelRow,
  session: FunnelSessionRow,
  contact: z.output<typeof ContactAnswer>,
  env: NodeJS.ProcessEnv,
): Promise<FunnelSessionRow> {
  const attribution = LeadAttributionSchema.safeParse((session.metadata as Record<string, unknown>).attribution);
  const lead = await createLead(db, organisationId, {
    name: contact.name,
    phone: contact.phone,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.business ? { business: contact.business } : {}),
    message: leadMessage(funnel, { ...session, answers: session.answers }),
    source: funnel.leadSource,
    ...(attribution.success ? { attribution: attribution.data } : {}),
    metadata: { funnel: { funnelId: funnel.id, slug: funnel.slug, sessionId: session.id, score: session.score } },
    actorKind: "client",
  }, env);

  const now = new Date();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.funnelSessions)
      .set({ leadId: lead.id, status: "contacted", contactedAt: now, updatedAt: now })
      .where(and(eq(schema.funnelSessions.id, session.id), eq(schema.funnelSessions.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: "client", action: "funnel.contact_captured", targetType: "funnel_session", targetId: session.id, before: session, after,
    });
    return after!;
  });
}

/** The lead's message: every question and what they said, in the funnel's order. */
function leadMessage(funnel: FunnelRow, session: Pick<FunnelSessionRow, "answers" | "score">): string {
  const lines = funnel.steps
    .filter((step) => step.kind !== "contact" && session.answers[step.key])
    .map((step) => `${step.question}\n— ${session.answers[step.key]!.label || "(no answer)"}`);
  const best = maximumScore(funnel.steps);
  const header = `From the "${funnel.name}" funnel · score ${session.score}${best > 0 ? ` of ${best}` : ""}`;
  return [header, ...lines].join("\n\n").slice(0, 4000);
}

/** Keeps the lead's message in step with the answers given after the contact screen. */
async function refreshLeadMessage(db: Db, organisationId: string, funnel: FunnelRow, session: FunnelSessionRow): Promise<void> {
  if (!session.leadId) return;
  const [before] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, session.leadId), eq(schema.leads.organisationId, organisationId)));
  if (!before) return;
  const [after] = await db.update(schema.leads)
    .set({
      message: leadMessage(funnel, session),
      metadata: { ...before.metadata, funnel: { funnelId: funnel.id, slug: funnel.slug, sessionId: session.id, score: session.score } },
      updatedAt: new Date(),
    })
    .where(and(eq(schema.leads.id, session.leadId), eq(schema.leads.organisationId, organisationId)))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "client", action: "lead.updated", targetType: "lead", targetId: session.leadId, before, after,
  });
}

/**
 * The hot-lead buzz. Once per session, stamped, and only for a funnel whose
 * `hot_score` is above zero — a threshold of nothing is not a threshold, and
 * buzzing on every lead would make the alert worth ignoring within a week.
 * `createLead` has already rung the ordinary `lead.created` bell; this is the
 * one that says "ring them now".
 */
async function maybeBuzz(db: Db, organisationId: string, funnel: FunnelRow, session: FunnelSessionRow): Promise<void> {
  if (funnel.hotScore <= 0 || session.score < funnel.hotScore || !session.leadId) return;
  if ((session.metadata as Record<string, unknown>)[HOT_NOTIFIED_KEY]) return;

  const now = new Date();
  const [claimed] = await db.update(schema.funnelSessions)
    .set({ metadata: { ...session.metadata, [HOT_NOTIFIED_KEY]: now.toISOString() }, updatedAt: now })
    .where(and(
      eq(schema.funnelSessions.id, session.id),
      eq(schema.funnelSessions.organisationId, organisationId),
      // The claim is the guard: two answers arriving together cannot both buzz.
      eq(schema.funnelSessions.score, session.score),
    ))
    .returning();
  if (!claimed) return;

  const best = maximumScore(funnel.steps);
  const answers = funnel.steps
    .filter((step) => step.kind === "choice" && session.answers[step.key])
    .map((step) => session.answers[step.key]!.label)
    .join(" · ");
  await notifyOwner(db, organisationId, {
    kind: FUNNEL_HOT_NOTIFICATION_KIND,
    title: `Hot lead from ${funnel.name}`,
    body: `Scored ${session.score}${best > 0 ? ` of ${best}` : ""}${answers ? `\n${answers}` : ""}\nRing them while they are still on the page.`,
    link: `/leads/${session.leadId}`,
  });
}
