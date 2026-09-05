import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  ActorKindSchema, CHANNEL_LABEL, ContentChannelSchema, ContentRefused, excerpt, isUniqueViolation, shortLondonDate,
  type ContentItemRow,
} from "./shared.js";

/** `payload.action` on a publish request — the key the pending index tests. */
export const CONTENT_PUBLISH_ACTION = "content_publish";

/** The partial unique index in `packages/db/src/schema/agents.ts` that keeps requests to one per item. */
export const PENDING_CONTENT_PUBLISH_INDEX = "approvals_pending_content_publish";

/** Metadata stamped on the approval once its decision has been carried out. */
const APPLIED_AT = "appliedAt";

export const RequestContentApprovalInput = z.object({
  itemId: z.string().uuid(),
  actorKind: ActorKindSchema,
  actorId: z.string().min(1).optional(),
  /** The agent run asking, when it is the content writer — lands on `approvals.run_id`. */
  runId: z.string().uuid().optional(),
});
export type RequestContentApprovalInput = z.input<typeof RequestContentApprovalInput>;

/**
 * What the approval row carries. The item is the record; these are the
 * fields the card renders without a second read, written at request time
 * so what the owner approved is what the payload says.
 */
export const ContentPublishPayload = z.object({
  action: z.literal(CONTENT_PUBLISH_ACTION),
  itemId: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  channel: ContentChannelSchema,
  kind: z.enum(schema.contentKindEnum.enumValues),
  title: z.string().nullable(),
  body: z.string(),
  imageUrl: z.string().nullable(),
  linkUrl: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  summary: z.string(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type ContentPublishPayload = z.infer<typeof ContentPublishPayload>;

export type ApprovalRow = typeof schema.approvals.$inferSelect;

/** `Publish Facebook post for Grays CabLine on 12 Sep: <first 80 chars>`. */
export function contentPublishSummary(item: ContentItemRow, clientName: string): string {
  const when = item.scheduledFor ? ` on ${shortLondonDate(item.scheduledFor)}` : "";
  const text = item.body?.trim() || item.title?.trim() || "";
  return `Publish ${CHANNEL_LABEL[item.channel]} for ${clientName}${when}: ${excerpt(text, 80)}`;
}

/**
 * Parks a content item in the approvals queue as a `content_publish`.
 *
 * Nothing goes out here. The item moves to `awaiting_approval` and a card
 * appears for the owner; `applyContentPublishDecision` then carries the
 * verdict onto the item. Only a draft with a body can ask — an empty slot has
 * nothing to approve — and the pending index refuses a second card for the
 * same item however the read-then-insert races.
 */
export async function requestContentApproval(
  db: Db,
  organisationId: string,
  input: RequestContentApprovalInput,
): Promise<{ item: ContentItemRow; approval: ApprovalRow }> {
  const v = RequestContentApprovalInput.parse(input);
  if (v.runId) await assertOwned(db, organisationId, schema.agentRuns, v.runId);

  const [found] = await db.select({ item: schema.contentItems, clientName: schema.clients.name })
    .from(schema.contentItems)
    .innerJoin(schema.clients, eq(schema.contentItems.clientId, schema.clients.id))
    .where(and(
      eq(schema.contentItems.id, v.itemId),
      eq(schema.contentItems.organisationId, organisationId),
      isNull(schema.contentItems.deletedAt),
    ));
  if (!found) throw new ContentRefused("not_found", `content item ${v.itemId} not found in organisation`);
  const { item, clientName } = found;
  if (item.status !== "draft") throw new ContentRefused("not_draft", `Only a draft can be sent for approval; this item is ${item.status.replace("_", " ")}.`);
  if (!item.body?.trim()) throw new ContentRefused("empty_body", "Write the post before sending it for approval.");

  const summary = contentPublishSummary(item, clientName);
  const payload: ContentPublishPayload = {
    action: CONTENT_PUBLISH_ACTION,
    itemId: item.id,
    clientId: item.clientId,
    clientName,
    channel: item.channel,
    kind: item.kind,
    title: item.title,
    body: item.body,
    imageUrl: item.imageUrl,
    linkUrl: item.linkUrl,
    scheduledFor: item.scheduledFor?.toISOString() ?? null,
    summary,
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };

  try {
    return await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const now = new Date();
      const [approval] = await tx.insert(schema.approvals).values({
        organisationId,
        runId: v.runId ?? null,
        kind: "content_publish",
        title: summary,
        payload,
      }).returning();
      const [after] = await tx.update(schema.contentItems)
        .set({ status: "awaiting_approval", approvalId: approval!.id, updatedAt: now })
        .where(and(
          eq(schema.contentItems.id, item.id),
          eq(schema.contentItems.organisationId, organisationId),
          eq(schema.contentItems.status, "draft"),
        ))
        .returning();
      if (!after) throw new ContentRefused("not_draft", "The item changed while it was being sent for approval.");
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "content_item.approval_requested",
        targetType: "content_item", targetId: item.id, before: item, after,
      });
      await recordActivity(tx, organisationId, {
        clientId: item.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "content_item.approval_requested",
        title: `${CHANNEL_LABEL[item.channel]} sent for approval${item.title ? `: ${item.title}` : ""}`,
        link: "/approvals",
      });
      return { item: after, approval: approval! };
    });
  } catch (error) {
    if (!isUniqueViolation(error, PENDING_CONTENT_PUBLISH_INDEX)) throw error;
    throw new ContentRefused("already_pending", "This post is already waiting for a decision.");
  }
}

export const ApplyContentPublishDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1),
});
export type ApplyContentPublishDecisionInput = z.input<typeof ApplyContentPublishDecisionInput>;

export interface ApplyContentPublishDecisionResult {
  decision: "approved" | "rejected";
  itemId: string;
  clientId: string;
  /** The item as it stands after the decision; unchanged when `alreadyApplied`. */
  item: ContentItemRow | undefined;
  /** True when this approval had already been carried out; nothing was touched. */
  alreadyApplied: boolean;
}

/**
 * Carries a decided `content_publish` approval onto its item.
 *
 * Called by the admin approvals action after `decideApproval` has stamped the
 * decision, for both verdicts. At most once per approval: the claim is one
 * conditional UPDATE on `approvals.metadata.appliedAt`, so a doubled click
 * cannot approve twice. Approve moves the item to `approved`, which is what
 * `claimDueContent` picks up at `scheduled_for`; an item with no date is
 * stamped "now" so it goes out on the next sweep, and one whose date has
 * passed goes out on the next sweep by the same rule. Reject moves it to
 * `rejected`, where an edit returns it to draft for another go.
 *
 * The item is only moved if it is still `awaiting_approval` on *this*
 * approval — cancelled, or re-requested under a newer card, it is left alone.
 */
export async function applyContentPublishDecision(
  db: Db,
  organisationId: string,
  input: ApplyContentPublishDecisionInput,
): Promise<ApplyContentPublishDecisionResult> {
  const v = ApplyContentPublishDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);

  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = ContentPublishPayload.parse(approval.payload);
  await assertOwned(db, organisationId, schema.contentItems, payload.itemId);

  const applied = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();

    const [claimed] = await tx.update(schema.approvals)
      .set({
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [APPLIED_AT]: now.toISOString(), appliedBy: v.actorId })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, v.approvalId),
        eq(schema.approvals.organisationId, organisationId),
        sql`(${schema.approvals.metadata}->>${APPLIED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return undefined;

    const [before] = await tx.select().from(schema.contentItems)
      .where(and(eq(schema.contentItems.id, payload.itemId), eq(schema.contentItems.organisationId, organisationId)))
      .for("update");

    let after: ContentItemRow | undefined = before;
    if (before && before.status === "awaiting_approval" && before.approvalId === v.approvalId) {
      const [updated] = await tx.update(schema.contentItems)
        .set(decision === "approved"
          ? { status: "approved", scheduledFor: before.scheduledFor ?? now, lastError: null, metadata: sql`coalesce(${schema.contentItems.metadata}, '{}'::jsonb) - 'publishAttempts'`, updatedAt: now }
          : { status: "rejected", updatedAt: now })
        .where(eq(schema.contentItems.id, before.id))
        .returning();
      after = updated;
      await recordAudit(tx, organisationId, {
        actorKind: "user", actorId: v.actorId, action: `content_item.${decision}`,
        targetType: "content_item", targetId: before.id, before, after,
      });
      await recordActivity(tx, organisationId, {
        clientId: before.clientId, actorKind: "user", actorId: v.actorId, kind: `content_item.${decision}`,
        title: `${CHANNEL_LABEL[before.channel]} ${decision}${before.title ? `: ${before.title}` : ""}`,
        ...(approval.decisionNote ? { body: approval.decisionNote } : {}),
        link: `/content/${before.id}`,
      });
    }

    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: `approval.content_publish_${decision}_applied`,
      targetType: "approval", targetId: v.approvalId, before: approval, after: claimed,
    });
    return { item: after };
  });

  if (!applied) return { decision, itemId: payload.itemId, clientId: payload.clientId, item: undefined, alreadyApplied: true };
  return { decision, itemId: payload.itemId, clientId: payload.clientId, item: applied.item, alreadyApplied: false };
}
