import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentChannel, ContentKind, ContentStatus } from "@launchos/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation, assertOwned } from "../tenancy/assert-owned.js";
import {
  ActorKindSchema, CANCELLABLE_STATUSES, CHANNEL_LABEL, ContentChannelSchema, ContentRefused, ContentStatusSchema,
  EDITABLE_STATUSES, KIND_FOR_CHANNEL, MAX_CONTENT_BODY_CHARS, MAX_CONTENT_TITLE_CHARS, PeriodKeySchema,
  REVISABLE_STATUSES, periodKeyFor, type ContentItemRow,
} from "./shared.js";

const Url = z.string().trim().url().max(2000);

export const CreateContentItemInput = z.object({
  clientId: z.string().uuid(),
  channel: ContentChannelSchema,
  /** Defaults to the current month in Europe/London. */
  periodKey: PeriodKeySchema.optional(),
  title: z.string().trim().max(MAX_CONTENT_TITLE_CHARS).optional(),
  body: z.string().trim().max(MAX_CONTENT_BODY_CHARS).optional(),
  imageUrl: Url.optional(),
  imagePrompt: z.string().trim().max(2000).optional(),
  linkUrl: Url.optional(),
  scheduledFor: z.coerce.date().optional(),
  taskId: z.string().uuid().optional(),
  source: z.enum(schema.contentSourceEnum.enumValues).default("staff"),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().min(1).optional(),
});
export type CreateContentItemInput = z.input<typeof CreateContentItemInput>;

/** `null` clears a field; omitting it leaves it alone. */
export const UpdateContentItemInput = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().max(MAX_CONTENT_TITLE_CHARS).nullable().optional(),
  body: z.string().trim().max(MAX_CONTENT_BODY_CHARS).nullable().optional(),
  imageUrl: Url.nullable().optional(),
  imagePrompt: z.string().trim().max(2000).nullable().optional(),
  linkUrl: Url.nullable().optional(),
  scheduledFor: z.coerce.date().nullable().optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().min(1).optional(),
});
export type UpdateContentItemInput = z.input<typeof UpdateContentItemInput>;

export const GetContentItemInput = z.object({ itemId: z.string().uuid() });
export type GetContentItemInput = z.input<typeof GetContentItemInput>;

export const CancelContentItemInput = z.object({
  itemId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().min(1).optional(),
});
export type CancelContentItemInput = z.input<typeof CancelContentItemInput>;

export const ListContentItemsInput = z.object({
  clientId: z.string().uuid().optional(),
  periodKey: PeriodKeySchema.optional(),
  status: z.array(ContentStatusSchema).min(1).optional(),
  channel: ContentChannelSchema.optional(),
  /**
   * "scheduled" — soonest first, undated last: the month's plan in order.
   * "recent" — newest first: a cross-client queue where the cap would
   * otherwise hide what was just created.
   */
  sort: z.enum(["scheduled", "recent"]).default("scheduled"),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListContentItemsInput = z.input<typeof ListContentItemsInput>;

export type ContentItemListRow = {
  id: string;
  clientId: string;
  clientName: string;
  channel: ContentChannel;
  kind: ContentKind;
  status: ContentStatus;
  periodKey: string;
  title: string | null;
  body: string | null;
  imageUrl: string | null;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  externalUrl: string | null;
  source: ContentItemRow["source"];
  createdAt: Date;
};

export type ContentItemDetail = ContentItemRow & { clientName: string };

export async function createContentItem(db: Db, organisationId: string, input: CreateContentItemInput): Promise<ContentItemRow> {
  const v = CreateContentItemInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);
  if (v.taskId) await assertOwned(db, organisationId, schema.tasks, v.taskId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.contentItems).values({
      organisationId,
      clientId: v.clientId,
      channel: v.channel,
      kind: KIND_FOR_CHANNEL[v.channel],
      periodKey: v.periodKey ?? periodKeyFor(v.scheduledFor ?? new Date()),
      title: v.title ?? null,
      body: v.body ?? null,
      imageUrl: v.imageUrl ?? null,
      imagePrompt: v.imagePrompt ?? null,
      linkUrl: v.linkUrl ?? null,
      scheduledFor: v.scheduledFor ?? null,
      taskId: v.taskId ?? null,
      source: v.source,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_item.created",
      targetType: "content_item", targetId: row!.id, after: row,
    });
    return row!;
  });
}

/** The row, or a `not_found` refusal — never another organisation's row. */
async function loadItem(db: Db, organisationId: string, itemId: string): Promise<ContentItemRow> {
  const [row] = await db.select().from(schema.contentItems).where(and(
    eq(schema.contentItems.id, itemId),
    eq(schema.contentItems.organisationId, organisationId),
    isNull(schema.contentItems.deletedAt),
  ));
  if (!row) throw new ContentRefused("not_found", `content item ${itemId} not found in organisation`);
  return row;
}

/**
 * Edits the text, image, link or date. Allowed while the item is a draft or
 * waiting for approval — an approved item is what the owner said yes to, and
 * changing it afterwards would publish something nobody approved. Editing a
 * rejected or failed item returns it to `draft`, because a revision needs
 * another look before it can go out.
 */
export async function updateContentItem(db: Db, organisationId: string, input: UpdateContentItemInput): Promise<ContentItemRow> {
  const v = UpdateContentItemInput.parse(input);
  const before = await loadItem(db, organisationId, v.itemId);

  const revising = REVISABLE_STATUSES.includes(before.status);
  if (!EDITABLE_STATUSES.includes(before.status) && !revising) {
    throw new ContentRefused("not_editable", `A ${before.status.replace("_", " ")} item cannot be edited.`);
  }

  const patch = {
    ...(v.title !== undefined ? { title: v.title } : {}),
    ...(v.body !== undefined ? { body: v.body } : {}),
    ...(v.imageUrl !== undefined ? { imageUrl: v.imageUrl } : {}),
    ...(v.imagePrompt !== undefined ? { imagePrompt: v.imagePrompt } : {}),
    ...(v.linkUrl !== undefined ? { linkUrl: v.linkUrl } : {}),
    ...(v.scheduledFor !== undefined ? { scheduledFor: v.scheduledFor } : {}),
    ...(revising ? { status: "draft" as const, lastError: null, approvalId: null } : {}),
  };

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.contentItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(schema.contentItems.id, before.id), eq(schema.contentItems.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: revising ? "content_item.revised" : "content_item.updated",
      targetType: "content_item", targetId: before.id, before, after,
    });
    return after!;
  });
}

export async function getContentItem(db: Db, organisationId: string, input: GetContentItemInput): Promise<ContentItemDetail | undefined> {
  const v = GetContentItemInput.parse(input);
  const [row] = await db.select({ item: schema.contentItems, clientName: schema.clients.name })
    .from(schema.contentItems)
    .innerJoin(schema.clients, eq(schema.contentItems.clientId, schema.clients.id))
    .where(and(
      eq(schema.contentItems.id, v.itemId),
      eq(schema.contentItems.organisationId, organisationId),
      isNull(schema.contentItems.deletedAt),
    ));
  return row ? { ...row.item, clientName: row.clientName } : undefined;
}

/**
 * Takes an item out of the month. A pending approval for it is withdrawn
 * (soft-deleted, the way `decideApproval` understands) so the card leaves the
 * queue and cannot be approved into a cancelled item. Published and publishing
 * items are past cancelling.
 */
export async function cancelContentItem(db: Db, organisationId: string, input: CancelContentItemInput): Promise<ContentItemRow> {
  const v = CancelContentItemInput.parse(input);
  const before = await loadItem(db, organisationId, v.itemId);
  if (!CANCELLABLE_STATUSES.includes(before.status)) {
    throw new ContentRefused("not_cancellable", `A ${before.status.replace("_", " ")} item cannot be cancelled.`);
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    if (before.approvalId) {
      const [withdrawn] = await tx.update(schema.approvals)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(schema.approvals.id, before.approvalId),
          eq(schema.approvals.organisationId, organisationId),
          eq(schema.approvals.status, "pending"),
          isNull(schema.approvals.deletedAt),
        ))
        .returning();
      if (withdrawn) {
        await recordAudit(tx, organisationId, {
          actorKind: v.actorKind, actorId: v.actorId, action: "approval.withdrawn",
          targetType: "approval", targetId: withdrawn.id, after: withdrawn,
        });
      }
    }
    const [after] = await tx.update(schema.contentItems)
      .set({
        status: "cancelled",
        updatedAt: now,
        metadata: sql`coalesce(${schema.contentItems.metadata}, '{}'::jsonb) || ${JSON.stringify({
          cancelledAt: now.toISOString(), ...(v.reason ? { cancelReason: v.reason } : {}),
        })}::jsonb`,
      })
      .where(and(eq(schema.contentItems.id, before.id), eq(schema.contentItems.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_item.cancelled",
      targetType: "content_item", targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: before.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "content_item.cancelled",
      title: `${CHANNEL_LABEL[before.channel]} cancelled${before.title ? `: ${before.title}` : ""}`,
      ...(v.reason ? { body: v.reason } : {}),
      link: `/content/${before.id}`,
    });
    return after!;
  });
}

export async function listContentItems(
  db: Db,
  organisationId: string,
  input: ListContentItemsInput = {},
): Promise<{ items: ContentItemListRow[]; total: number }> {
  const f = ListContentItemsInput.parse(input);
  const where: SQL[] = [eq(schema.contentItems.organisationId, organisationId), isNull(schema.contentItems.deletedAt)];
  if (f.clientId) where.push(eq(schema.contentItems.clientId, f.clientId));
  if (f.periodKey) where.push(eq(schema.contentItems.periodKey, f.periodKey));
  if (f.status) where.push(inArray(schema.contentItems.status, f.status));
  if (f.channel) where.push(eq(schema.contentItems.channel, f.channel));

  const order = f.sort === "recent"
    ? [desc(schema.contentItems.createdAt), asc(schema.contentItems.id)]
    : [sql`${schema.contentItems.scheduledFor} asc nulls last`, asc(schema.contentItems.createdAt), asc(schema.contentItems.id)];

  const [[counted], rows] = [
    await db.select({ value: count() }).from(schema.contentItems).where(and(...where)),
    await db.select({
      id: schema.contentItems.id,
      clientId: schema.contentItems.clientId,
      clientName: schema.clients.name,
      channel: schema.contentItems.channel,
      kind: schema.contentItems.kind,
      status: schema.contentItems.status,
      periodKey: schema.contentItems.periodKey,
      title: schema.contentItems.title,
      body: schema.contentItems.body,
      imageUrl: schema.contentItems.imageUrl,
      scheduledFor: schema.contentItems.scheduledFor,
      publishedAt: schema.contentItems.publishedAt,
      externalUrl: schema.contentItems.externalUrl,
      source: schema.contentItems.source,
      createdAt: schema.contentItems.createdAt,
    })
      .from(schema.contentItems)
      .innerJoin(schema.clients, eq(schema.contentItems.clientId, schema.clients.id))
      .where(and(...where))
      .orderBy(...order)
      .limit(f.limit)
      .offset(f.offset),
  ];
  return { items: rows, total: counted!.value };
}
