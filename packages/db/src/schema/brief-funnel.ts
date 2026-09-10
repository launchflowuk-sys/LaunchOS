import { bigint, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantColumns } from "./_shared.js";
import { leads } from "./leads.js";

/**
 * The website brief funnel: eight stages, saved as they are answered.
 *
 * **Not the Funnel Engine.** `funnels.ts` next door is a configurable
 * ad-landing builder — a funnel is a row, its questions are jsonb, it lives at
 * `/f/<slug>` and it scores answers to buzz the owner on a hot lead. Its
 * session token is explicitly a tab-lifetime claim that "never leaves their
 * browser tab".
 *
 * This is one fixed questionnaire that has to survive a closed laptop: resume
 * from an emailed link on another device, file uploads, optimistic concurrency
 * across two tabs, and an immutable AI brief written from a frozen snapshot.
 * None of that fits a scoring engine, and bending one into the other would
 * make both worse. They share the thing that matters — `leads`.
 *
 * The point of this, and the reason it is not just a longer form, is that a
 * **lead exists before the questionnaire is finished**. Somebody who types a
 * phone number and closes the tab is a person we can ring; the old form gave us
 * nothing until they pressed Send on the last screen. So the contact details
 * live on `leads` — the canonical record the whole system already feeds from —
 * and everything here hangs off it.
 *
 * `leads` is deliberately untouched by this file beyond the foreign key.
 * `convertLeadToClient`, the Lead Qualifier and the site-build pipeline all
 * read that table and must keep working exactly as they do.
 */

export const briefSessionStatusEnum = pgEnum("brief_session_status", [
  /** Being filled in. The only state that accepts writes. */
  "draft",
  /** Sent. The answers are frozen and a brief is being written from them. */
  "submitted",
  /** Past `expires_at`. Kept for the lead's sake, not resumable. */
  "expired",
]);
export type BriefSessionStatus = (typeof briefSessionStatusEnum.enumValues)[number];

/**
 * One person's run at the questionnaire.
 *
 * `session_secret_hash` is the whole authorisation story: the browser holds an
 * opaque high-entropy secret in an HttpOnly cookie and we hold only its hash,
 * so a leaked database gives nobody a way back into a draft. The row id is an
 * identifier, never a credential — anyone who guesses it gets nothing.
 *
 * `revision` is what makes concurrent edits safe. Every write states the
 * revision it expected; the transaction increments it and hands back the
 * committed number. Two tabs on the same draft cannot silently overwrite each
 * other, and the client can tell "saved" from "sent".
 */
export const briefSessions = pgTable(
  "brief_sessions",
  {
    ...tenantColumns(),
    /** Null until a valid email or phone arrives. An anonymous draft is allowed. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** SHA-256 of the cookie secret. The secret itself is never stored. */
    sessionSecretHash: text("session_secret_hash").notNull(),
    /** Which set of questions this draft was started against, so answers stay readable after the form changes. */
    questionnaireVersion: integer("questionnaire_version").notNull(),
    /** 1..8. Where they are, not the furthest they reached. */
    currentStep: integer("current_step").default(1).notNull(),
    /** Steps the server has accepted as complete — the only thing the progress bar may believe. */
    completedSteps: jsonb("completed_steps").$type<number[]>().default([]).notNull(),
    answers: jsonb("answers").$type<Record<string, unknown>>().default({}).notNull(),
    revision: bigint("revision", { mode: "number" }).default(0).notNull(),
    status: briefSessionStatusEnum("status").default("draft").notNull(),
    /**
     * Where they came from — UTM fields and the entry route, constrained and
     * truncated on the way in. Never contact details: those belong on the lead
     * and must not reach analytics.
     */
    source: jsonb("source").$type<Record<string, string>>().default({}).notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("brief_sessions_secret").on(t.sessionSecretHash),
    index("brief_sessions_org_lead").on(t.organisationId, t.leadId),
    index("brief_sessions_org_status_activity").on(t.organisationId, t.status, t.lastActivityAt),
    index("brief_sessions_expiry").on(t.expiresAt),
    check("brief_sessions_revision_non_negative", sql`${t.revision} >= 0`),
    check("brief_sessions_step_range", sql`${t.currentStep} between 1 and 8`),
  ],
);

/**
 * Proof that a given write already happened.
 *
 * A patch that times out on the wire gets retried by the browser with the same
 * `mutation_id`. Without this the retry applies the change twice — which for a
 * revision counter means the second attempt fails a conflict check it should
 * have passed, and the customer is told their answer clashed with itself.
 *
 * Digest rather than values on purpose: this table is a bookkeeping trail, and
 * putting a phone number in it would spread contact details into a place
 * nothing else has to protect.
 */
export const briefMutations = pgTable(
  "brief_mutations",
  {
    ...tenantColumns(),
    sessionId: uuid("session_id").notNull().references(() => briefSessions.id, { onDelete: "cascade" }),
    /** Client-generated UUID, unique per session. */
    mutationId: text("mutation_id").notNull(),
    /** The revision this write produced, replayed verbatim to a retry. */
    resultRevision: bigint("result_revision", { mode: "number" }).notNull(),
    /** SHA-256 of the request body, so a reused id carrying different fields is caught. */
    requestDigest: text("request_digest").notNull(),
  },
  (t) => [
    uniqueIndex("brief_mutations_session_mutation").on(t.sessionId, t.mutationId),
    index("brief_mutations_created").on(t.createdAt),
  ],
);

/**
 * A one-time link back into a draft.
 *
 * Hashed, expiring, and consumed by POST rather than GET — mail scanners and
 * link previewers fetch every URL in a message, and a token spent by Outlook
 * before the customer ever clicks is a support call we would never diagnose.
 * The landing page shows a neutral Continue; only pressing it exchanges.
 *
 * `consumed_at` and `revoked_at` are separate: one is a link that did its job,
 * the other a link deliberately killed. Both refuse, and both must give the
 * *same* neutral answer as an unknown token, or the endpoint becomes a way to
 * ask whether an address is on file.
 */
export const briefResumeTokens = pgTable(
  "brief_resume_tokens",
  {
    ...tenantColumns(),
    sessionId: uuid("session_id").notNull().references(() => briefSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("brief_resume_tokens_hash").on(t.tokenHash),
    index("brief_resume_tokens_session").on(t.sessionId),
    index("brief_resume_tokens_expiry").on(t.expiresAt),
  ],
);

export const briefAssetStatusEnum = pgEnum("brief_asset_status", [
  /** Intent recorded, bytes not yet confirmed. Never shown as uploaded. */
  "pending",
  /** Bytes received, being checked. */
  "scanning",
  /** Checked and usable. The only status the brief generator may read. */
  "ready",
  /** Failed a check. Kept with its reason so the customer can be told which file and why. */
  "rejected",
  /** Removed by the customer. */
  "deleted",
]);
export type BriefAssetStatus = (typeof briefAssetStatusEnum.enumValues)[number];

/**
 * A logo, a photo, a PDF of their old brochure.
 *
 * Private storage, per-draft authorisation, and `status` gating everything: a
 * file is not "uploaded" because a browser finished sending it, it is uploaded
 * when the server has the bytes, checked the magic numbers against the declared
 * type and written this row. Anything not `ready` is excluded from what the
 * model sees — an unscanned file is untrusted input twice over.
 */
export const briefAssets = pgTable(
  "brief_assets",
  {
    ...tenantColumns(),
    sessionId: uuid("session_id").notNull().references(() => briefSessions.id, { onDelete: "cascade" }),
    /** Key in private storage. Never a public URL, never derived from the original name. */
    storageKey: text("storage_key").notNull(),
    /** What the customer called it, for showing back to them. Not used as a path. */
    originalName: text("original_name").notNull(),
    /** Sniffed from the bytes, not trusted from the browser. */
    detectedMime: text("detected_mime"),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    checksum: text("checksum"),
    status: briefAssetStatusEnum("status").default("pending").notNull(),
    /** Why it was refused, in words a customer can act on. */
    rejectedReason: text("rejected_reason"),
  },
  (t) => [
    uniqueIndex("brief_assets_storage_key").on(t.storageKey),
    index("brief_assets_session_status").on(t.sessionId, t.status),
    check("brief_assets_bytes_non_negative", sql`${t.bytes} >= 0`),
  ],
);

/**
 * The moment the answers stopped being editable.
 *
 * `answers` here is a frozen copy, not a pointer at the session. The brief that
 * goes to a client has to be defensible six months later — "this is what you
 * told us" only means anything if the snapshot cannot drift when somebody
 * reopens their draft.
 *
 * `idempotency_key` is what makes a double-tapped Send button one submission.
 * The unique constraint does the work; the code around it only has to notice
 * the conflict and hand back what already exists.
 */
export const briefSubmissions = pgTable(
  "brief_submissions",
  {
    ...tenantColumns(),
    sessionId: uuid("session_id").notNull().references(() => briefSessions.id, { onDelete: "cascade" }),
    /** 1, then 2 if they are allowed to send again after a change. */
    submissionVersion: integer("submission_version").default(1).notNull(),
    answers: jsonb("answers").$type<Record<string, unknown>>().notNull(),
    /** The session revision the snapshot was taken at, so the two can be lined up later. */
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    questionnaireVersion: integer("questionnaire_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** What the customer is told to quote. Opaque — it says nothing about volume. */
    reference: text("reference").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("brief_submissions_session_idempotency").on(t.sessionId, t.idempotencyKey),
    uniqueIndex("brief_submissions_session_version").on(t.sessionId, t.submissionVersion),
    uniqueIndex("brief_submissions_reference").on(t.reference),
    index("brief_submissions_org_submitted").on(t.organisationId, t.submittedAt),
  ],
);

/**
 * A written brief, kept for ever.
 *
 * Version 1 is deterministic Markdown built straight from the answers, written
 * before the model is called at all. That ordering is the point: if the model
 * is down, over quota or returns something that fails the schema, there is
 * still a readable brief and the customer's submission was never at risk.
 *
 * `generator_version` and the model metadata are what let a bad batch be traced
 * to its cause rather than argued about.
 */
export const briefVersions = pgTable(
  "brief_versions",
  {
    ...tenantColumns(),
    submissionId: uuid("submission_id").notNull().references(() => briefSubmissions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Null on the deterministic first pass — there is nothing structured to store yet. */
    structured: jsonb("structured").$type<Record<string, unknown>>(),
    markdown: text("markdown").notNull(),
    /** "deterministic" or the model that wrote it. */
    generatorVersion: text("generator_version").notNull(),
    schemaVersion: text("schema_version"),
    model: text("model"),
  },
  (t) => [
    uniqueIndex("brief_versions_submission_version").on(t.submissionId, t.version),
    index("brief_versions_submission").on(t.submissionId),
  ],
);
