import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { LEAD_REPLY_KIND } from "../support/send-queued-message.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { ensureLeadConversation } from "./acknowledge.js";
import { bookingLinkFor } from "./booking-link.js";
import { markLeadContacted } from "./leads.js";

/** `approvals.kind` AND `payload.action` on a drafted lead reply. */
export const LEAD_REPLY_ACTION = "lead_reply";
/** The partial unique index that keeps pending drafts to one per lead. */
export const PENDING_LEAD_REPLY_INDEX = "approvals_pending_lead_reply";

export class LeadReplyRefused extends Error {
  constructor(readonly reason: "not_found" | "no_email" | "already_pending" | "converted", message: string) {
    super(message);
    this.name = "LeadReplyRefused";
  }
}

/**
 * What the approval card renders and what `applyLeadReplyDecision` sends.
 * The lead's own words are copied in so the card shows the enquiry next to
 * the draft without another read; `body` is the model's text and exactly
 * what the approver must read. An edited body is passed to
 * `applyLeadReplyDecision`, never written back here.
 */
export const LeadReplyPayload = z.object({
  action: z.literal(LEAD_REPLY_ACTION),
  leadId: z.string().uuid(),
  leadName: z.string(),
  leadBusiness: z.string().nullable(),
  leadEmail: z.string(),
  leadMessage: z.string().nullable(),
  leadSource: z.string(),
  subject: z.string(),
  body: z.string(),
  suggestedPackageSlug: z.string().nullable(),
  suggestedPackageName: z.string().nullable(),
  suggestedPackageMonthlyPence: z.number().int().nullable(),
  questions: z.array(z.string()),
  bookingUrl: z.string(),
  requestedByKind: z.enum(["user", "client", "agent", "system"]),
  requestedById: z.string().nullable(),
});
export type LeadReplyPayload = z.infer<typeof LeadReplyPayload>;

type ApprovalRow = typeof schema.approvals.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

export const RequestLeadReplyInput = z.object({
  leadId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  suggestedPackageSlug: z.string().trim().min(1).max(60).optional(),
  questions: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("agent"),
  actorId: z.string().min(1).optional(),
});
export type RequestLeadReplyInput = z.input<typeof RequestLeadReplyInput>;

/**
 * Puts a drafted first reply in front of the owner as a `lead_reply` approval
 * — run-less, decided on /approvals, carried out by `applyLeadReplyDecision`.
 * Nothing is sent here. Refused for a lead with no email, one already
 * converted, or one with a draft already waiting (the partial unique index).
 * The owner's bell gets `approval.requested` — urgent, so it reaches the
 * phone the way a new lead did.
 */
export async function requestLeadReply(
  db: Db,
  organisationId: string,
  input: RequestLeadReplyInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ approval: ApprovalRow; payload: LeadReplyPayload }> {
  const v = RequestLeadReplyInput.parse(input);
  const [lead] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, v.leadId), eq(schema.leads.organisationId, organisationId)));
  if (!lead) throw new LeadReplyRefused("not_found", "That lead could not be found.");
  if (!lead.email) throw new LeadReplyRefused("no_email", "This lead left no email address, so there is nobody to reply to.");
  if (lead.status === "converted") throw new LeadReplyRefused("converted", "This lead is already a client; write to them from their client page.");

  const [pkg] = v.suggestedPackageSlug
    ? await db.select({ slug: schema.packages.slug, name: schema.packages.name, monthlyPricePence: schema.packages.monthlyPricePence })
        .from(schema.packages)
        .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.slug, v.suggestedPackageSlug), eq(schema.packages.active, true)))
    : [];

  const payload: LeadReplyPayload = {
    action: LEAD_REPLY_ACTION,
    leadId: lead.id,
    leadName: lead.name,
    leadBusiness: lead.business,
    leadEmail: lead.email,
    leadMessage: lead.message,
    leadSource: lead.source,
    subject: v.subject,
    body: v.body,
    suggestedPackageSlug: pkg?.slug ?? null,
    suggestedPackageName: pkg?.name ?? null,
    suggestedPackageMonthlyPence: pkg?.monthlyPricePence ?? null,
    questions: v.questions,
    bookingUrl: bookingLinkFor(lead, env),
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };
  const title = `Reply to ${lead.business ?? lead.name}: ${v.subject}`;

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId, kind: LEAD_REPLY_ACTION, title, payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "lead.reply_drafted", targetType: "lead", targetId: lead.id, after: row,
      });
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new LeadReplyRefused("already_pending", "A reply to this lead is already waiting for a decision.");
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: "approval.requested",
    title: `Approve: reply to ${lead.business ?? lead.name}`,
    body: `${v.subject}${pkg ? ` — suggests ${pkg.name}` : ""}. Approve to email ${lead.email}.`,
    link: "/approvals",
  });
  return { approval, payload };
}

export const ApplyLeadReplyDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
  /** Edit-and-approve: the body from the card's textarea replaces the draft. Ignored on reject. */
  body: z.string().trim().min(1).max(8000).optional(),
});
export type ApplyLeadReplyDecisionInput = z.input<typeof ApplyLeadReplyDecisionInput>;

export interface ApplyLeadReplyDecisionResult {
  decision: "approved" | "rejected";
  leadId: string;
  /** The queued email. Null on reject or when already applied. */
  message: MessageRow | null;
  alreadyApplied: boolean;
}

/** Stamped on the approval once carried out — the at-most-once claim. */
const APPLIED_AT = "appliedAt";

/** The reply as sent: the (possibly edited) body with the booking link appended once. */
export function leadReplyBody(body: string, bookingUrl: string): string {
  const trimmed = body.trim();
  if (trimmed.includes(bookingUrl)) return trimmed;
  return `${trimmed}\n\nIf it's easier to talk it through, pick a time for a quick call:\n\n${bookingUrl}`;
}

/**
 * Carries out a decided lead reply. Call after `decideApproval`, for both
 * verdicts. At most once per approval (`approvals.metadata.appliedAt` claim).
 * Approved: one branded email from the support mailbox is queued on the
 * lead's thread — the card's body if it was edited, else the draft — with the
 * booking link appended; the lead moves to `contacted`; timeline
 * `lead.replied`; `message.queued` emitted after commit. Rejected: nothing is
 * sent; timeline `lead.reply_rejected` with the decision note.
 */
export async function applyLeadReplyDecision(
  db: Db,
  organisationId: string,
  input: ApplyLeadReplyDecisionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyLeadReplyDecisionResult> {
  const v = ApplyLeadReplyDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = LeadReplyPayload.parse(approval.payload);
  const [lead] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, payload.leadId), eq(schema.leads.organisationId, organisationId)));
  if (!lead) throw new Error(`lead ${payload.leadId} not found in organisation`);

  const applied = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    const [claimed] = await tx.update(schema.approvals)
      .set({
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [APPLIED_AT]: now.toISOString(), appliedBy: v.actorId, ...(v.body ? { edited: true } : {}) })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, v.approvalId),
        eq(schema.approvals.organisationId, organisationId),
        sql`(${schema.approvals.metadata}->>${APPLIED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return undefined;

    if (decision !== "approved") {
      await recordAudit(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, action: "lead.reply_rejected", targetType: "lead", targetId: lead.id, before: approval, after: claimed,
      });
      await recordActivity(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, kind: "lead.reply_rejected",
        title: `Drafted reply to ${lead.business ?? lead.name} was not sent`,
        ...(approval.decisionNote ? { body: approval.decisionNote } : {}),
        link: `/leads/${lead.id}`,
      });
      return { message: null };
    }

    const bookingUrl = bookingLinkFor(lead, env);
    const conversation = await ensureLeadConversation(tx, organisationId, lead);
    const [message] = await tx.insert(schema.messages).values({
      organisationId,
      conversationId: conversation.id,
      direction: "outbound",
      authorKind: "user",
      authorId: v.actorId,
      body: leadReplyBody(v.body ?? payload.body, bookingUrl),
      fromEmail: brandSupportAddress(env),
      toEmail: payload.leadEmail,
      subject: payload.subject,
      status: "queued",
      metadata: { kind: LEAD_REPLY_KIND, leadId: lead.id, approvalId: v.approvalId, bookingUrl, draftedBy: payload.requestedById, edited: !!v.body },
    }).returning();
    await tx.update(schema.conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(schema.conversations.id, conversation.id));
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "message.queued", targetType: "message", targetId: message!.id, after: message,
    });
    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "lead.replied", targetType: "lead", targetId: lead.id, before: approval, after: claimed,
    });
    await markLeadContacted(tx, organisationId, lead.id, { actorKind: "user", actorId: v.actorId });
    await recordActivity(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, kind: "lead.replied",
      title: `Replied to ${lead.business ?? lead.name}: ${payload.subject}`,
      body: `Emailed ${payload.leadEmail}${payload.suggestedPackageName ? `; suggested ${payload.suggestedPackageName}` : ""}.`,
      link: `/leads/${lead.id}`,
    });
    return { message: message! };
  });

  if (!applied) return { decision, leadId: lead.id, message: null, alreadyApplied: true };
  if (applied.message) await emit({ name: "message.queued", organisationId, messageId: applied.message.id });
  return { decision, leadId: lead.id, message: applied.message, alreadyApplied: false };
}

/** The lead's thread with every email on it, oldest first — for the lead page. */
export async function listLeadMessages(db: Db, organisationId: string, leadId: string): Promise<MessageRow[]> {
  const [conversation] = await db.select({ id: schema.conversations.id }).from(schema.conversations)
    .where(and(eq(schema.conversations.organisationId, organisationId), eq(schema.conversations.leadId, leadId)))
    .limit(1);
  if (!conversation) return [];
  return db.select().from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.conversationId, conversation.id)))
    .orderBy(schema.messages.createdAt, schema.messages.id);
}
