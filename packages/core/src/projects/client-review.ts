import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { decideApproval } from "../approvals/decide-approval.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  ActorKindSchema,
  PROJECT_TARGET_TYPE,
  ProjectRefused,
  requireMilestoneOfProject,
  requireProject,
} from "./shared.js";

/**
 * A client being invited to look at something — and nothing waiting on them.
 *
 * This is Shoji's decision, and it is the whole design. Every other approval
 * in LaunchOS is a gate: a proposal cannot go out, a post cannot publish, an
 * agent cannot touch DNS until somebody says yes. A `client_review` is the
 * opposite. It is raised against a project or one of its milestones, it
 * carries a note and a picture, and **nothing in the system reads it before
 * doing anything**. A task does not wait on it. A phase does not wait on it. A
 * milestone can be reached with one open, and a project can be delivered with
 * one open. There is no branch anywhere that asks "is a review outstanding?"
 * and stops — and there must never be one, which is why
 * `client-review.test.ts` drives a whole project from planned to delivered
 * with a review sitting untouched and asserts that every step succeeded.
 *
 * The reason is that Shoji's clients are small businesses. A plumber who does
 * not open his email for nine days has not rejected the design; he has been
 * under a sink. A build that stops for him turns a nine-day silence into a
 * nine-day delay and then into an argument about whose fault the delay was.
 * So the client's answer is welcome and useful, and the work carries on
 * without it. What an unanswered review does earn, after
 * `CLIENT_REVIEW_STALE_DAYS`, is one line in the morning Ops Brief — a person
 * being told to pick up the phone, which is the only thing that actually
 * works.
 *
 * The client has two answers, and neither is "no":
 *
 * - **Approve** — "happy with that". The card is decided, and the timeline
 *   says so.
 * - **Comment** — "the green is too dark". This is *not* a rejection, so it
 *   does not decide the card: the client may well comment on Monday and
 *   approve on Thursday once the green has changed, and a card closed as
 *   `rejected` on Monday would have nowhere to put Thursday. A comment is a
 *   message on the timeline, a bell for Shoji, and a stamp on the review that
 *   stops it counting as untouched in the brief.
 *
 * Nothing here emails anybody. A review that chased the client would be a
 * blocker wearing a different hat — it would be asking them to hurry over
 * something we have just said we are not waiting for. It appears in their
 * portal, it rides along in the Friday update they already get, and after five
 * days Shoji is told to ring them.
 */

/** `approvals.kind` AND `payload.action` on a review waiting for a client. */
export const CLIENT_REVIEW_ACTION = "client_review";

/** The partial unique index that keeps open reviews to one per thing reviewed. */
export const PENDING_CLIENT_REVIEW_INDEX = "approvals_pending_client_review";

/**
 * How long an unanswered review sits before the Ops Brief mentions it.
 *
 * Five working-ish days: long enough that a client who is simply busy is not
 * chased, short enough that a design nobody has looked at does not reach
 * launch unseen. It is a prompt to Shoji and never a deadline to the client.
 */
export const CLIENT_REVIEW_STALE_DAYS = 5;

/** `approvals.metadata` — when the client last said something on this review. */
export const CLIENT_REVIEW_COMMENTED_AT = "commentedAt";
/** `approvals.metadata.comments` — every comment, in order, as the record of the conversation. */
export const CLIENT_REVIEW_COMMENTS = "comments";

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** `milestone:<id>` where there is one, `project:<id>` otherwise — the index's key. */
export function clientReviewTargetRef(projectId: string, milestoneId?: string | null): string {
  return milestoneId ? `milestone:${milestoneId}` : `project:${projectId}`;
}

/**
 * What the card carries, written from our own rows at request time.
 *
 * The client reads this in their portal, so it holds the note, the links and
 * the pictures and nothing else. No price, no internal task, no staff name —
 * a review is "have a look at this", not a window onto the build.
 */
export const ClientReviewPayload = z.object({
  action: z.literal(CLIENT_REVIEW_ACTION),
  targetRef: z.string(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  milestoneId: z.string().uuid().nullable(),
  milestoneTitle: z.string().nullable(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  /** What we are asking them to look at, in Shoji's words. */
  note: z.string(),
  /** Public addresses — a staging site, a preview page. */
  links: z.array(z.string()),
  /** Content-asset URLs; the portal draws them, the email never does. */
  screenshots: z.array(z.string()),
  summary: z.string(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type ClientReviewPayload = z.infer<typeof ClientReviewPayload>;

export const RequestClientReviewInput = z.object({
  projectId: z.string().uuid(),
  /** The milestone this is about, when it is about one. */
  milestoneId: z.string().uuid().optional(),
  note: z.string().trim().min(1, "say what you would like them to look at").max(4000),
  links: z.array(z.string().trim().url().max(500)).max(10).default([]),
  /** Content assets already uploaded for this client — pass their public URLs. */
  screenshots: z.array(z.string().trim().max(500)).max(10).default([]),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type RequestClientReviewInput = z.input<typeof RequestClientReviewInput>;

export class ClientReviewRefused extends Error {
  constructor(
    readonly reason: "already_open" | "not_found" | "already_decided",
    message: string,
  ) {
    super(message);
    this.name = "ClientReviewRefused";
  }
}

/** True when `error` is the pending index refusing a second open review. */
function isOpenReviewCollision(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (typeof node !== "object") return false;
    const candidate = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === PENDING_CLIENT_REVIEW_INDEX || candidate.constraint === PENDING_CLIENT_REVIEW_INDEX)
    ) {
      return true;
    }
    node = candidate.cause;
  }
  return false;
}

/**
 * Invites the client to look at something.
 *
 * Refused only when the same thing is already open — the index decides that,
 * and the message says so plainly rather than pretending a second card was
 * created. Nothing else can refuse: a review is never conditional on the state
 * of the work, because it never affects the state of the work.
 */
export async function requestClientReview(
  db: Db,
  organisationId: string,
  input: RequestClientReviewInput,
): Promise<{ approval: ApprovalRow; payload: ClientReviewPayload }> {
  const v = RequestClientReviewInput.parse(input);
  const project = await requireProject(db, organisationId, v.projectId);
  const milestone = v.milestoneId ? await requireMilestoneOfProject(db, organisationId, v.projectId, v.milestoneId) : null;

  const [client] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, project.clientId), eq(schema.clients.organisationId, organisationId)));
  const clientName = client?.name ?? "The client";
  const about = milestone ? milestone.title : project.name;
  const summary = `${clientName} is asked to look at ${about}`;

  const payload: ClientReviewPayload = {
    action: CLIENT_REVIEW_ACTION,
    targetRef: clientReviewTargetRef(project.id, milestone?.id ?? null),
    projectId: project.id,
    projectName: project.name,
    milestoneId: milestone?.id ?? null,
    milestoneTitle: milestone?.title ?? null,
    clientId: project.clientId,
    clientName,
    note: v.note,
    links: [...v.links],
    screenshots: [...v.screenshots],
    summary,
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId,
        kind: CLIENT_REVIEW_ACTION,
        title: `Review: ${about}`,
        payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "project.client_review_requested",
        targetType: PROJECT_TARGET_TYPE, targetId: project.id, after: row,
      });
      // Client-visible on purpose: this is the line in their timeline that
      // says we asked, so a review nobody answers is still on the record.
      await recordActivity(tx, organisationId, {
        clientId: project.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.client_review_requested",
        title: `Your thoughts, when you have a minute: ${about}`,
        body: v.note,
        link: `/projects/${project.id}`,
      });
      return row!;
    });
  } catch (error) {
    if (!isOpenReviewCollision(error)) throw error;
    throw new ClientReviewRefused("already_open", `${clientName} has already been asked to look at ${about}.`);
  }
  return { approval, payload };
}

export const ListClientReviewsInput = z.object({
  projectId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  /** `pending` for the portal's "waiting for you"; omitted for the whole history. */
  status: z.enum(schema.approvalStatusEnum.enumValues).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListClientReviewsInput = z.input<typeof ListClientReviewsInput>;

/**
 * The reviews on a project or a client, newest first.
 *
 * Filtered on `payload->>` rather than a join, the way the plan-change lookups
 * are: an approval has no project column, and giving it one would mean a
 * migration every time a new kind of card arrives.
 */
export async function listClientReviews(
  db: Db,
  organisationId: string,
  input: ListClientReviewsInput = {},
): Promise<ApprovalRow[]> {
  const v = ListClientReviewsInput.parse(input);
  return db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = ${CLIENT_REVIEW_ACTION}`,
      v.status ? eq(schema.approvals.status, v.status) : undefined,
      v.projectId ? sql`${schema.approvals.payload}->>'projectId' = ${v.projectId}` : undefined,
      v.clientId ? sql`${schema.approvals.payload}->>'clientId' = ${v.clientId}` : undefined,
    ))
    .orderBy(desc(schema.approvals.createdAt), desc(schema.approvals.id))
    .limit(v.limit);
}

/** One review, or null when it is another tenant's, gone, or not a review at all. */
export async function getClientReview(db: Db, organisationId: string, approvalId: string): Promise<ApprovalRow | null> {
  const [row] = await db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.id, approvalId),
      eq(schema.approvals.organisationId, organisationId),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = ${CLIENT_REVIEW_ACTION}`,
    ));
  return row ?? null;
}

export const AnswerClientReviewInput = z.object({
  approvalId: z.string().uuid(),
  /** The Better Auth user id of the portal user answering. */
  actorUserId: z.string().min(1),
  note: z.string().trim().max(4000).optional(),
});
export type AnswerClientReviewInput = z.input<typeof AnswerClientReviewInput>;

/**
 * "Happy with that."
 *
 * `decideApproval` does the claim, so two taps on a phone produce one decision
 * and one timeline entry. Nothing downstream is unblocked by it, because
 * nothing was blocked.
 */
export async function approveClientReview(
  db: Db,
  organisationId: string,
  input: AnswerClientReviewInput,
): Promise<ApprovalRow> {
  const v = AnswerClientReviewInput.parse(input);
  const review = await getClientReview(db, organisationId, v.approvalId);
  if (!review) throw new ClientReviewRefused("not_found", "That review could not be found.");
  const payload = ClientReviewPayload.parse(review.payload);

  const decided = await decideApproval(db, organisationId, {
    approvalId: v.approvalId,
    decision: "approved",
    decidedByUserId: v.actorUserId,
    ...(v.note ? { note: v.note } : {}),
  });
  if (decided.alreadyDecided) {
    throw new ClientReviewRefused("already_decided", "That has already been answered.");
  }

  const about = payload.milestoneTitle ?? payload.projectName;
  await recordAudit(db, organisationId, {
    actorKind: "client", actorId: v.actorUserId, action: "project.client_review_approved",
    targetType: PROJECT_TARGET_TYPE, targetId: payload.projectId, before: decided.before, after: decided.after,
  });
  await recordActivity(db, organisationId, {
    clientId: payload.clientId, actorKind: "client", actorId: v.actorUserId, kind: "project.client_review_approved",
    title: `${payload.clientName} is happy with ${about}`,
    ...(v.note ? { body: v.note } : {}),
    link: `/projects/${payload.projectId}`,
  });
  await notifyOwner(db, organisationId, {
    kind: "project.client_review_approved",
    title: `${payload.clientName} approved ${about}`,
    ...(v.note ? { body: v.note } : {}),
    link: `/projects/${payload.projectId}`,
  });
  return decided.after;
}

export const CommentOnClientReviewInput = AnswerClientReviewInput.extend({
  note: z.string().trim().min(1, "write what you would like changed").max(4000),
});
export type CommentOnClientReviewInput = z.input<typeof CommentOnClientReviewInput>;

export interface ClientReviewComment {
  at: string;
  byUserId: string;
  body: string;
}

/**
 * "The green is too dark."
 *
 * **A comment does not decide the card.** It is not a rejection and it must
 * not read as one: the client is telling us something, we change it, and they
 * may well approve the same review on Thursday. Closing it as `rejected` on
 * Monday would leave Thursday's answer nowhere to go, and would put the word
 * "rejected" on a timeline where the client said nothing of the kind.
 *
 * What it does do is append to `metadata.comments` and stamp `commentedAt`,
 * which is what keeps it out of the Ops Brief's stale list — a review that is
 * being talked about is not a review nobody has looked at. The append is one
 * conditional UPDATE with `||` on the jsonb, so two comments a moment apart
 * both land rather than one overwriting the other.
 */
export async function commentOnClientReview(
  db: Db,
  organisationId: string,
  input: CommentOnClientReviewInput,
): Promise<{ approval: ApprovalRow; comments: ClientReviewComment[] }> {
  const v = CommentOnClientReviewInput.parse(input);
  const review = await getClientReview(db, organisationId, v.approvalId);
  if (!review) throw new ClientReviewRefused("not_found", "That review could not be found.");
  if (review.status !== "pending") {
    throw new ClientReviewRefused("already_decided", "That review has already been answered.");
  }
  const payload = ClientReviewPayload.parse(review.payload);
  const now = new Date();
  const comment: ClientReviewComment = { at: now.toISOString(), byUserId: v.actorUserId, body: v.note };

  const updated = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx
      .update(schema.approvals)
      .set({
        // Every parameter is cast: Postgres cannot infer the type of a bare
        // placeholder inside `jsonb_build_object` or `->` and answers
        // "could not determine data type of parameter" instead.
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb)
          || ${JSON.stringify({ [CLIENT_REVIEW_COMMENTED_AT]: now.toISOString() })}::jsonb
          || jsonb_build_object(${CLIENT_REVIEW_COMMENTS}::text,
               coalesce(${schema.approvals.metadata}->(${CLIENT_REVIEW_COMMENTS}::text), '[]'::jsonb) || ${JSON.stringify([comment])}::jsonb)`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, review.id),
        eq(schema.approvals.organisationId, organisationId),
        eq(schema.approvals.status, "pending"),
      ))
      .returning();
    if (!after) return null;
    await recordAudit(tx, organisationId, {
      actorKind: "client", actorId: v.actorUserId, action: "project.client_review_commented",
      targetType: PROJECT_TARGET_TYPE, targetId: payload.projectId, before: review, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: payload.clientId, actorKind: "client", actorId: v.actorUserId, kind: "project.client_review_commented",
      title: `${payload.clientName} left a comment on ${payload.milestoneTitle ?? payload.projectName}`,
      body: v.note,
      link: `/projects/${payload.projectId}`,
    });
    return after;
  });
  if (!updated) throw new ClientReviewRefused("already_decided", "That review has already been answered.");

  await notifyOwner(db, organisationId, {
    kind: "project.client_review_commented",
    title: `${payload.clientName} commented on ${payload.milestoneTitle ?? payload.projectName}`,
    body: v.note,
    link: `/projects/${payload.projectId}`,
  });
  return { approval: updated, comments: commentsOf(updated) };
}

/** The comments on a review, oldest first. Anything malformed is dropped, never thrown on. */
export function commentsOf(approval: ApprovalRow): ClientReviewComment[] {
  const raw = approval.metadata[CLIENT_REVIEW_COMMENTS];
  if (!Array.isArray(raw)) return [];
  const parsed = z.array(z.object({ at: z.string(), byUserId: z.string(), body: z.string() })).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export interface StaleClientReview {
  approval: ApprovalRow;
  payload: ClientReviewPayload;
  /** Whole days since it was raised, at the clock the caller passed. */
  daysWaiting: number;
}

/**
 * Reviews raised more than `CLIENT_REVIEW_STALE_DAYS` ago that the client has
 * neither answered nor commented on — the Ops Brief's one line, and the only
 * consequence an unanswered review has anywhere in LaunchOS.
 *
 * A commented review is excluded: the client has engaged, the ball is ours,
 * and telling Shoji to chase somebody who has already written to him is the
 * fastest way to make him stop reading the brief.
 */
export async function staleClientReviews(
  db: Db,
  organisationId: string,
  options: { now?: Date; days?: number; limit?: number } = {},
): Promise<StaleClientReview[]> {
  const now = options.now ?? new Date();
  const days = options.days ?? CLIENT_REVIEW_STALE_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload}->>'action' = ${CLIENT_REVIEW_ACTION}`,
      sql`(${schema.approvals.metadata}->>${CLIENT_REVIEW_COMMENTED_AT}) IS NULL`,
      lt(schema.approvals.createdAt, cutoff),
    ))
    .orderBy(asc(schema.approvals.createdAt), asc(schema.approvals.id))
    .limit(options.limit ?? 20);

  return rows.flatMap((approval) => {
    const parsed = ClientReviewPayload.safeParse(approval.payload);
    if (!parsed.success) return [];
    const daysWaiting = Math.floor((now.getTime() - approval.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    return [{ approval, payload: parsed.data, daysWaiting }];
  });
}

/** Withdraws a review nobody needs an answer to any more. Frees the index slot. */
export async function withdrawClientReview(
  db: Db,
  organisationId: string,
  input: { approvalId: string; actorId?: string | undefined },
): Promise<ApprovalRow> {
  const approvalId = z.string().uuid().parse(input.approvalId);
  await assertOwned(db, organisationId, schema.approvals, approvalId);
  const review = await getClientReview(db, organisationId, approvalId);
  if (!review) throw new ClientReviewRefused("not_found", "That review could not be found.");
  const now = new Date();
  const [after] = await db
    .update(schema.approvals)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.organisationId, organisationId), isNull(schema.approvals.deletedAt)))
    .returning();
  if (!after) throw new ClientReviewRefused("not_found", "That review has already been withdrawn.");
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "project.client_review_withdrawn",
    targetType: PROJECT_TARGET_TYPE, targetId: ClientReviewPayload.parse(review.payload).projectId, before: review, after,
  });
  return after;
}

export { ProjectRefused };
