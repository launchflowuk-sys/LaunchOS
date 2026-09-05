import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { truncate, MAX_ERROR_CHARS } from "../text.js";
import { ActorKindSchema, CHANNEL_LABEL, ContentRefused, type ContentItemRow } from "./shared.js";

/** How many times the publish job tries an item before giving up on it. */
export const MAX_CONTENT_PUBLISH_ATTEMPTS = 3;

export const ClaimDueContentInput = z.object({
  now: z.coerce.date().default(() => new Date()),
  limit: z.number().int().min(1).max(200).default(20),
});
export type ClaimDueContentInput = z.input<typeof ClaimDueContentInput>;

export const MarkContentPublishedInput = z.object({
  itemId: z.string().uuid(),
  externalId: z.string().min(1).max(500),
  /** Absent when the permalink lookup failed — the post is live either way. */
  externalUrl: z.string().url().max(2000).optional(),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type MarkContentPublishedInput = z.input<typeof MarkContentPublishedInput>;

export const MarkContentFailedInput = z.object({
  itemId: z.string().uuid(),
  error: z.string().min(1),
  /**
   * False for an error a retry cannot fix — an auth failure, media the
   * platform refused — so the item fails now rather than after three goes.
   */
  retry: z.boolean().default(true),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type MarkContentFailedInput = z.input<typeof MarkContentFailedInput>;

export interface MarkContentFailedResult {
  item: ContentItemRow;
  attempts: number;
  /** True when the item has been given up on and the owner told. */
  exhausted: boolean;
}

/**
 * Claims the items that are approved and due — `scheduled_for <= now` — by
 * moving them to `publishing`. The rows are locked first with `FOR UPDATE
 * SKIP LOCKED`, so two workers sweeping at once split the batch rather than
 * both taking the same items, and the UPDATE that follows in the same
 * transaction can only touch what this worker locked. (A `LIMIT … FOR UPDATE`
 * subquery inside the UPDATE's `IN` is not used on purpose: Postgres may plan
 * it as a semi-join and re-run it per row, handing back more than `limit`.)
 * Because the status flip is the claim, a worker that dies mid-publish leaves
 * the item `publishing`, visible in the admin list as stuck rather than
 * silently sent twice.
 */
export async function claimDueContent(db: Db, organisationId: string, input: ClaimDueContentInput = {}): Promise<ContentItemRow[]> {
  const v = ClaimDueContentInput.parse(input);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const due = await tx.select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.status, "approved"),
        lte(schema.contentItems.scheduledFor, v.now),
        isNull(schema.contentItems.deletedAt),
      ))
      .orderBy(asc(schema.contentItems.scheduledFor), asc(schema.contentItems.id))
      .limit(v.limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];

    const claimed = await tx.update(schema.contentItems)
      .set({ status: "publishing", updatedAt: v.now })
      .where(and(
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.status, "approved"),
        inArray(schema.contentItems.id, due.map((row) => row.id)),
      ))
      .returning();

    for (const item of claimed) {
      await recordAudit(tx, organisationId, {
        actorKind: "system", action: "content_item.publishing",
        targetType: "content_item", targetId: item.id, before: { ...item, status: "approved" }, after: item,
      });
    }
    return claimed.sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0));
  });
}

async function loadPublishing(db: Db, organisationId: string, itemId: string): Promise<ContentItemRow> {
  const [row] = await db.select().from(schema.contentItems).where(and(
    eq(schema.contentItems.id, itemId),
    eq(schema.contentItems.organisationId, organisationId),
    isNull(schema.contentItems.deletedAt),
  ));
  if (!row) throw new ContentRefused("not_found", `content item ${itemId} not found in organisation`);
  if (row.status !== "publishing") throw new ContentRefused("not_publishing", `content item ${itemId} is ${row.status}, not publishing`);
  return row;
}

/** The platform took it. Records the id and permalink and tells the timeline. */
export async function markContentPublished(db: Db, organisationId: string, input: MarkContentPublishedInput): Promise<ContentItemRow> {
  const v = MarkContentPublishedInput.parse(input);
  const before = await loadPublishing(db, organisationId, v.itemId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    const [after] = await tx.update(schema.contentItems)
      .set({
        status: "published",
        publishedAt: now,
        externalId: v.externalId,
        externalUrl: v.externalUrl ?? null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(
        eq(schema.contentItems.id, before.id),
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.status, "publishing"),
      ))
      .returning();
    if (!after) throw new ContentRefused("not_publishing", `content item ${before.id} changed while being marked published`);
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_item.published",
      targetType: "content_item", targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      clientId: before.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "content_item.published",
      title: `${CHANNEL_LABEL[before.channel]} published${before.title ? `: ${before.title}` : ""}`,
      link: v.externalUrl ?? `/content/${before.id}`,
    });
    return after;
  });
}

/**
 * The platform refused it. Counts the attempt in `metadata.publishAttempts`
 * and puts the item back to `approved` so the next sweep retries it; after
 * `MAX_CONTENT_PUBLISH_ATTEMPTS` — or straight away when `retry` is false —
 * the item is `failed` and the owner is told, because nothing automatic will
 * touch it again.
 */
export async function markContentFailed(db: Db, organisationId: string, input: MarkContentFailedInput): Promise<MarkContentFailedResult> {
  const v = MarkContentFailedInput.parse(input);
  const before = await loadPublishing(db, organisationId, v.itemId);
  const attempts = (Number(before.metadata.publishAttempts) || 0) + 1;
  const exhausted = !v.retry || attempts >= MAX_CONTENT_PUBLISH_ATTEMPTS;
  const message = truncate(v.error, MAX_ERROR_CHARS);

  const item = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    const stamp = { publishAttempts: attempts, lastFailedAt: now.toISOString() };
    const [after] = await tx.update(schema.contentItems)
      .set({
        status: exhausted ? "failed" : "approved",
        lastError: message,
        metadata: sql`coalesce(${schema.contentItems.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.contentItems.id, before.id),
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.status, "publishing"),
      ))
      .returning();
    if (!after) throw new ContentRefused("not_publishing", `content item ${before.id} changed while being marked failed`);
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: exhausted ? "content_item.failed" : "content_item.publish_retry",
      targetType: "content_item", targetId: before.id, before, after,
    });
    if (exhausted) {
      await recordActivity(tx, organisationId, {
        clientId: before.clientId, actorKind: "system", kind: "content_item.failed",
        title: `${CHANNEL_LABEL[before.channel]} could not be published${before.title ? `: ${before.title}` : ""}`,
        body: message,
        link: `/content/${before.id}`,
      });
    }
    return after;
  });

  if (exhausted) {
    // After commit, and never a reason to fail the bookkeeping: the item is
    // the record; this is the nudge that says a person has to look.
    const [client] = await db.select({ name: schema.clients.name }).from(schema.clients)
      .where(and(eq(schema.clients.id, before.clientId), eq(schema.clients.organisationId, organisationId)));
    await notifyOwner(db, organisationId, {
      kind: "content_item.failed",
      title: `A ${CHANNEL_LABEL[before.channel].toLowerCase()} for ${client?.name ?? "a client"} could not be published`,
      body: v.retry ? `Gave up after ${attempts} attempts: ${message}` : message,
      link: `/content/${before.id}`,
    });
  }

  return { item, attempts, exhausted };
}
