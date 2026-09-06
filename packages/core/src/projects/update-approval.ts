import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { PROJECT_UPDATE_NOTICE_KIND } from "../support/courtesy-notice.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { ActorKindSchema, PROJECT_TARGET_TYPE, ProjectRefused, requireProject } from "./shared.js";

/**
 * The Friday note to a client, and the human gate in front of it.
 *
 * The Project Reporter writes it; it never sends it. The draft is parked as a
 * `project_update` card with the whole body on it, Shoji reads it, edits it if
 * the model has been over-cheerful about a week that was quiet, and approves.
 * Only then does anything reach a client — which is rule 2 of `CLAUDE.md`
 * applied to the one agent whose entire output is a message to a client.
 *
 * Run-less, like `content_publish`, `lead_reply` and `proposal_send`: the
 * agent's run has finished by the time anybody looks at the card, so there is
 * nothing for the kernel to resume and `applyProjectUpdateDecision` carries
 * the decision out instead. Unlike `proposal_send`, applying it needs neither
 * a browser nor an HTTP call — it writes a `queued` message row and emits
 * `message.queued` — so the web app applies it inline rather than queueing a
 * job for the worker.
 */

/** `approvals.kind` AND `payload.action` on an update waiting to go out. */
export const PROJECT_UPDATE_ACTION = "project_update";
/** The partial unique index that keeps pending updates to one per project. */
export const PENDING_PROJECT_UPDATE_INDEX = "approvals_pending_project_update";
/** Stamped on the approval once carried out — the at-most-once claim. */
export const PROJECT_UPDATE_APPLIED_AT = "appliedAt";

/** The subject a client sees when nothing better was written. */
export const PROJECT_UPDATE_DEFAULT_SUBJECT = "Your project update";

/** Long enough for a real week, short enough that nobody writes an essay. */
export const PROJECT_UPDATE_MAX_CHARS = 4000;

type ApprovalRow = typeof schema.approvals.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

/**
 * What the card carries.
 *
 * `body` is the text that will actually be sent, not the agent's account of
 * it: the card shows the client's email, word for word, because approving
 * something you have only been told about is not approval.
 */
export const ProjectUpdatePayload = z.object({
  action: z.literal(PROJECT_UPDATE_ACTION),
  projectId: z.string().uuid(),
  projectName: z.string(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  subject: z.string(),
  body: z.string(),
  /** The window the update covers, so a late approval still says which week it was. */
  periodStart: z.string(),
  periodEnd: z.string(),
  /** What the bar said when it was written. Shown beside the body on the card. */
  progressPercent: z.number().int().min(0).max(100),
  summary: z.string(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type ProjectUpdatePayload = z.infer<typeof ProjectUpdatePayload>;

export const RequestProjectUpdateApprovalInput = z.object({
  projectId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1, "there is nothing to send").max(PROJECT_UPDATE_MAX_CHARS),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  progressPercent: z.number().int().min(0).max(100),
  actorKind: ActorKindSchema.default("agent"),
  actorId: z.string().min(1).optional(),
  runId: z.string().uuid().optional(),
});
export type RequestProjectUpdateApprovalInput = z.input<typeof RequestProjectUpdateApprovalInput>;

export class ProjectUpdateRefused extends Error {
  constructor(
    readonly reason: "already_pending" | "no_recipient" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ProjectUpdateRefused";
  }
}

/** True when `error` is the pending index refusing a second card for one project. */
function isPendingUpdateCollision(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (typeof node !== "object") return false;
    const candidate = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === PENDING_PROJECT_UPDATE_INDEX || candidate.constraint === PENDING_PROJECT_UPDATE_INDEX)
    ) {
      return true;
    }
    node = candidate.cause;
  }
  return false;
}

/**
 * The client's portal users, active only, with the client's own address as the
 * fallback so a client managed by email alone still gets their update.
 *
 * The same rule as `applySubscriptionChangeDecision`: a suspended login is
 * somebody who should not be told anything.
 */
export async function projectUpdateRecipients(db: Db, organisationId: string, clientId: string): Promise<string[]> {
  const users = await db
    .select({ email: schema.user.email })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(
      eq(schema.clientUsers.organisationId, organisationId),
      eq(schema.clientUsers.clientId, clientId),
      eq(schema.clientUsers.status, "active"),
    ));
  const addresses = [...new Set(users.map((row) => row.email.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length > 0) return addresses;

  const [client] = await db
    .select({ email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return client?.email ? [client.email.trim().toLowerCase()] : [];
}

/**
 * Parks a drafted update in the approvals queue.
 *
 * Refused when there is nobody to write to — the same check
 * `requestProposalApproval` makes, made now rather than after Shoji has
 * pressed Approve on something that cannot be delivered — and when a card for
 * this project is already waiting, which the index decides.
 */
export async function requestProjectUpdateApproval(
  db: Db,
  organisationId: string,
  input: RequestProjectUpdateApprovalInput,
): Promise<{ approval: ApprovalRow; payload: ProjectUpdatePayload }> {
  const v = RequestProjectUpdateApprovalInput.parse(input);
  if (v.runId) await assertOwned(db, organisationId, schema.agentRuns, v.runId);
  const project = await requireProject(db, organisationId, v.projectId);

  const [client] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, project.clientId), eq(schema.clients.organisationId, organisationId)));
  const clientName = client?.name ?? "The client";

  const recipients = await projectUpdateRecipients(db, organisationId, project.clientId);
  if (recipients.length === 0) {
    throw new ProjectUpdateRefused("no_recipient", `There is no email address on ${clientName} to send an update to.`);
  }

  const subject = v.subject ?? `${project.name}: ${PROJECT_UPDATE_DEFAULT_SUBJECT.toLowerCase()}`;
  const summary = `Send ${clientName} this week's update on ${project.name} (${v.progressPercent}% through)`;
  const payload: ProjectUpdatePayload = {
    action: PROJECT_UPDATE_ACTION,
    projectId: project.id,
    projectName: project.name,
    clientId: project.clientId,
    clientName,
    subject,
    body: v.body,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    progressPercent: v.progressPercent,
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
        runId: v.runId ?? null,
        kind: PROJECT_UPDATE_ACTION,
        title: summary,
        payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "project.update_requested",
        targetType: PROJECT_TARGET_TYPE, targetId: project.id, after: row,
      });
      await recordActivity(tx, organisationId, {
        clientId: project.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "project.update_requested",
        title: `This week's update on ${project.name} is waiting for approval`,
        link: "/approvals",
      });
      return row!;
    });
  } catch (error) {
    if (!isPendingUpdateCollision(error)) throw error;
    throw new ProjectUpdateRefused("already_pending", `An update on ${project.name} is already waiting for a decision.`);
  }

  await notifyOwner(db, organisationId, {
    kind: "approval.requested",
    title: `Approve: this week's update on ${project.name}`,
    body: `${clientName}, ${v.progressPercent}% through. Approve to email ${recipients.length === 1 ? recipients[0] : `${recipients.length} people`}.`,
    link: "/approvals",
  });
  return { approval, payload };
}

export const ApplyProjectUpdateDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
  /** Shoji's edit of the body, when he rewrote it on the card. */
  body: z.string().trim().min(1).max(PROJECT_UPDATE_MAX_CHARS).optional(),
});
export type ApplyProjectUpdateDecisionInput = z.input<typeof ApplyProjectUpdateDecisionInput>;

export interface ApplyProjectUpdateDecisionResult {
  decision: "approved" | "rejected";
  projectId: string;
  clientId: string;
  /** One `queued` row per portal address. Empty on a rejection. */
  messages: MessageRow[];
  /** True when this approval had already been carried out; nothing was touched. */
  alreadyApplied: boolean;
}

/**
 * Carries a decided `project_update` out.
 *
 * Claim first, then write — the ordinary order, and the right one here,
 * because everything that follows the claim is a database write in the same
 * transaction. (`applyProposalSendDecision` inverts it only because it renders
 * a PDF, which can fail halfway; nothing here can.)
 *
 * The body sent is the one on the card unless the approver passed an edit,
 * which is how a "we're nearly there" the model wrote about a week that was
 * actually slow becomes an honest sentence before anybody reads it. The edited
 * text is written back onto the payload so the approval is the record of what
 * went out, not of what was proposed.
 *
 * Rejecting sends nothing and leaves the note on the timeline. There is no
 * "send it later" state: next Friday writes a new one.
 */
export async function applyProjectUpdateDecision(
  db: Db,
  organisationId: string,
  input: ApplyProjectUpdateDecisionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyProjectUpdateDecisionResult> {
  const v = ApplyProjectUpdateDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = ProjectUpdatePayload.parse(approval.payload);
  const body = v.body ?? payload.body;

  const recipients = decision === "approved" ? await projectUpdateRecipients(db, organisationId, payload.clientId) : [];
  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, payload.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);

  const applied = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();

    const [claimed] = await tx.update(schema.approvals)
      .set({
        payload: sql`${schema.approvals.payload} || ${JSON.stringify({ body })}::jsonb`,
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [PROJECT_UPDATE_APPLIED_AT]: now.toISOString(), appliedBy: v.actorId })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, v.approvalId),
        eq(schema.approvals.organisationId, organisationId),
        sql`(${schema.approvals.metadata}->>${PROJECT_UPDATE_APPLIED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return undefined;

    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: `approval.project_update_${decision}_applied`,
      targetType: "approval", targetId: v.approvalId, before: approval, after: claimed,
    });
    await recordActivity(tx, organisationId, {
      clientId: payload.clientId, actorKind: "user", actorId: v.actorId, kind: `project.update_${decision}`,
      title: decision === "approved"
        ? `This week's update on ${payload.projectName} was sent`
        : `This week's update on ${payload.projectName} was not sent`,
      ...(approval.decisionNote ? { body: approval.decisionNote } : {}),
      link: `/projects/${payload.projectId}`,
    });

    const messages: MessageRow[] = [];
    if (decision === "approved" && recipients.length > 0) {
      // Its own conversation, closed from the start: an update is a record of
      // what we told the client, not a thread anybody has to answer.
      const [conversation] = await tx.insert(schema.conversations).values({
        organisationId,
        clientId: payload.clientId,
        subject: payload.subject,
        channel: "portal",
        status: "closed",
        lastMessageAt: now,
      }).returning();
      for (const to of recipients) {
        const [message] = await tx.insert(schema.messages).values({
          organisationId,
          conversationId: conversation!.id,
          direction: "outbound",
          authorKind: "system",
          authorId: null,
          body,
          fromEmail: from,
          toEmail: to,
          subject: payload.subject,
          status: "queued",
          metadata: {
            kind: PROJECT_UPDATE_NOTICE_KIND,
            projectId: payload.projectId,
            approvalId: v.approvalId,
            progressPercent: payload.progressPercent,
          },
        }).returning();
        await recordAudit(tx, organisationId, {
          actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
        });
        messages.push(message!);
      }
    }
    return { messages };
  });

  if (!applied) {
    return { decision, projectId: payload.projectId, clientId: payload.clientId, messages: [], alreadyApplied: true };
  }
  // After commit: the worker must never be handed an id the transaction rolled back.
  for (const message of applied.messages) {
    await emit({ name: "message.queued", organisationId, messageId: message.id });
  }
  return { decision, projectId: payload.projectId, clientId: payload.clientId, messages: applied.messages, alreadyApplied: false };
}

/**
 * Decided `project_update` cards nobody has carried out yet.
 *
 * The web app applies the decision inline, so this only ever finds a card
 * whose request died between `decideApproval` committing and the apply — rare,
 * and worth a sweep because the alternative is a client who was promised an
 * update that silently never went.
 */
export async function projectUpdatesAwaitingApplication(
  db: Db,
  organisationId: string,
  limit = 50,
): Promise<ApprovalRow[]> {
  return db.select().from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.kind, PROJECT_UPDATE_ACTION),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.status} <> 'pending'`,
      sql`${schema.approvals.metadata}->>${PROJECT_UPDATE_APPLIED_AT} is null`,
    ))
    .orderBy(asc(schema.approvals.decidedAt), asc(schema.approvals.id))
    .limit(limit);
}

export { ProjectRefused };
