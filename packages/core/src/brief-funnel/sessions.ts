import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";

/**
 * Starting, reading and writing a website brief draft.
 *
 * Two ideas carry this file, and both exist because a person filling in eight
 * screens on a phone will close the tab, lose signal and open a second tab.
 *
 * **The cookie secret is the only credential.** The browser holds an opaque
 * 256-bit value; we hold its SHA-256. The row id is an identifier — anybody who
 * guesses one gets nothing, because every read and write is looked up by hash.
 *
 * **Every write states the revision it expected.** The transaction increments
 * it and returns the committed number, so two tabs cannot silently overwrite
 * each other and the UI can only say "Saved" about a number the database gave
 * it back.
 */

/** How long a draft stays resumable before it stops being useful to anybody. */
export const SESSION_TTL_DAYS = 30;

/** The question set these answers were written against. Bump when the shape changes. */
export const QUESTIONNAIRE_VERSION = 1;

export type BriefSessionRow = typeof schema.briefSessions.$inferSelect;

/** What the browser is given back. Never includes the secret or the hash. */
export interface SafeSession {
  id: string;
  revision: number;
  currentStep: number;
  completedSteps: number[];
  answers: Record<string, unknown>;
  status: schema.BriefSessionStatus;
  leadCaptured: boolean;
}

export function toSafeSession(row: BriefSessionRow): SafeSession {
  return {
    id: row.id,
    revision: row.revision,
    currentStep: row.currentStep,
    completedSteps: row.completedSteps,
    answers: row.answers,
    status: row.status,
    leadCaptured: row.leadId !== null,
  };
}

/** SHA-256, hex. One place, so a read and a write can never disagree about it. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Source metadata worth keeping, and nothing else.
 *
 * An allow-list rather than "whatever was on the URL": a query string is
 * attacker-controlled and ends up in analytics, logs and a staff screen. Values
 * are truncated because a 4KB utm_content is not campaign data, it is a payload.
 */
const SOURCE_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "entry_route"] as const;
const SOURCE_MAX_CHARS = 200;

export function safeSource(input: Record<string, unknown> | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const key of SOURCE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      out[key] = value.trim().slice(0, SOURCE_MAX_CHARS);
    }
  }
  return out;
}

export const StartSessionInput = z.object({
  questionnaireVersion: z.number().int().positive().default(QUESTIONNAIRE_VERSION),
  source: z.record(z.string(), z.unknown()).optional(),
});
export type StartSessionInput = z.input<typeof StartSessionInput>;

/**
 * Opens an anonymous draft and returns the secret exactly once.
 *
 * The secret is returned rather than stored so the caller can put it in an
 * HttpOnly cookie and forget it. There is deliberately no way to read it back:
 * a lost cookie means a resume link, not a lookup.
 */
export async function startBriefSession(
  db: Db,
  organisationId: string,
  input: StartSessionInput = {},
): Promise<{ session: SafeSession; secret: string }> {
  const v = StartSessionInput.parse(input);
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(schema.briefSessions)
    .values({
      organisationId,
      sessionSecretHash: hashSecret(secret),
      questionnaireVersion: v.questionnaireVersion,
      source: safeSource(v.source),
      expiresAt,
    })
    .returning();

  return { session: toSafeSession(row!), secret };
}

/**
 * The draft behind a cookie secret, or null.
 *
 * Null covers every failure the same way — wrong secret, deleted row, expired
 * draft — because the caller's only correct response to all three is the same
 * neutral "start again", and distinguishing them out loud would turn this into
 * a way to test whether a draft exists.
 */
export async function briefSessionBySecret(
  db: Db,
  organisationId: string,
  secret: string,
  now: Date = new Date(),
): Promise<BriefSessionRow | null> {
  if (!secret) return null;
  const [row] = await db
    .select()
    .from(schema.briefSessions)
    .where(
      and(
        eq(schema.briefSessions.organisationId, organisationId),
        eq(schema.briefSessions.sessionSecretHash, hashSecret(secret)),
      ),
    );
  if (!row) return null;
  if (row.expiresAt <= now) return null;
  // A brief that has been sent is finished, and the cookie outlives it. Handing
  // it back meant one browser could only ever submit once: the next person on
  // that computer resumed a stranger's answers and had no way to start again.
  // Null here makes the caller open a fresh draft, which is what they want.
  if (row.status !== "draft") return null;
  return row;
}

/** Thrown when the caller's `expectedRevision` is behind. Carries the truth so the client can merge. */
export class RevisionConflict extends Error {
  constructor(readonly currentRevision: number, readonly answers: Record<string, unknown>) {
    super("that draft changed somewhere else");
    this.name = "RevisionConflict";
  }
}

export const PatchInput = z.object({
  mutationId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  /** Only the fields that changed. A whole-document write would clobber another tab. */
  fields: z.record(z.string(), z.unknown()),
});
export type PatchInput = z.input<typeof PatchInput>;

export interface PatchResult {
  revision: number;
  savedAt: Date;
  /** Which field names were actually committed, so the UI ticks only those. */
  acknowledged: string[];
  /** True when this was a retry of a write that had already landed. */
  replayed: boolean;
}

/**
 * Applies a patch, exactly once.
 *
 * The whole thing is one transaction because three things have to agree: the
 * answers, the revision, and the receipt saying this mutation happened. A
 * crash between any two of those is what produces a draft that cannot be
 * written to again.
 *
 * A repeated `mutationId` returns the original result rather than applying the
 * change twice. That is not an edge case — it is what a phone on a bad
 * connection does every time a request times out after the server committed it.
 */
export async function patchBriefSession(
  db: Db,
  organisationId: string,
  sessionId: string,
  input: PatchInput,
): Promise<PatchResult> {
  const v = PatchInput.parse(input);
  const digest = createHash("sha256").update(JSON.stringify(v.fields)).digest("hex");

  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(schema.briefMutations)
      .where(
        and(
          eq(schema.briefMutations.sessionId, sessionId),
          eq(schema.briefMutations.mutationId, v.mutationId),
        ),
      );
    if (receipt) {
      // Same id, different body: the client has reused a mutation id for a new
      // change, which would make the reply a lie. Better to fail loudly.
      if (receipt.requestDigest !== digest) throw new Error("that mutation id was already used for a different change");
      return { revision: receipt.resultRevision, savedAt: receipt.createdAt, acknowledged: Object.keys(v.fields), replayed: true };
    }

    const [before] = await tx
      .select()
      .from(schema.briefSessions)
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)));
    if (!before) throw new Error("that draft could not be found");
    if (before.status !== "draft") throw new Error("that brief has already been sent");
    if (before.revision !== v.expectedRevision) throw new RevisionConflict(before.revision, before.answers);

    const now = new Date();
    const [after] = await tx
      .update(schema.briefSessions)
      .set({
        // Merged, not replaced. A patch carries only what changed, and the rest
        // of the draft belongs to whoever wrote it.
        answers: { ...before.answers, ...v.fields },
        revision: before.revision + 1,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)))
      .returning();

    await tx.insert(schema.briefMutations).values({
      organisationId,
      sessionId,
      mutationId: v.mutationId,
      resultRevision: after!.revision,
      requestDigest: digest,
    });

    return { revision: after!.revision, savedAt: now, acknowledged: Object.keys(v.fields), replayed: false };
  });
}

/**
 * Records that a step is finished and moves on.
 *
 * `completedSteps` is a set on the server, not a count in the browser. The
 * progress bar is allowed to believe this and nothing else — a client that
 * decides for itself which steps are done is a client that can skip validation
 * by editing its own state.
 */
export async function completeBriefStep(
  db: Db,
  organisationId: string,
  sessionId: string,
  step: number,
): Promise<{ currentStep: number; completedSteps: number[] }> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.briefSessions)
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)));
    if (!before) throw new Error("that draft could not be found");
    if (before.status !== "draft") throw new Error("that brief has already been sent");

    const completed = [...new Set([...before.completedSteps, step])].sort((a, b) => a - b);
    const next = Math.min(step + 1, TOTAL_STEPS);
    const now = new Date();

    const [after] = await tx
      .update(schema.briefSessions)
      .set({ completedSteps: completed, currentStep: next, lastActivityAt: now, updatedAt: now })
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)))
      .returning();

    return { currentStep: after!.currentStep, completedSteps: after!.completedSteps };
  });
}

/** Eight stages, as specified. Here so nothing has to write `8` in three places. */
export const TOTAL_STEPS = 8;

/**
 * Marks drafts nobody came back to.
 *
 * Not a delete: the lead is the valuable part and it lives elsewhere. This only
 * stops a stale draft being resumable, which is what `expires_at` already
 * promises the customer.
 */
export async function expireStaleSessions(db: Db, organisationId: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(schema.briefSessions)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.briefSessions.organisationId, organisationId),
        eq(schema.briefSessions.status, "draft"),
        lte(schema.briefSessions.expiresAt, now),
      ),
    )
    .returning({ id: schema.briefSessions.id });
  return rows.length;
}
