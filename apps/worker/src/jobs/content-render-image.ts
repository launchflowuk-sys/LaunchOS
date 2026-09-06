import { renderContentImage, type RenderContentImageResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ImageGenAdapter } from "@launchos/integrations";
import { and, eq, inArray, isNull, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { QUEUE } from "../boss.js";
import { sweep, type SweepLogger } from "./sweep.js";

/**
 * Drawing a post its picture, off the request that asked for it.
 *
 * Rendering is slow — a template render is Satori and Sharp, an AI one is a
 * round trip to a provider — so the post editor, the approval card and the
 * publish sweep all hand it to this queue rather than holding a request open.
 * Nothing here reaches a client: the picture is written to our own storage
 * volume and the `content_publish` approval is still the only outward gate.
 */

/** The channels the last-chance backfill covers: the three a person would notice a missing picture on. */
export const BACKFILL_CHANNELS = ["facebook", "instagram", "gbp"] as const;

/**
 * The dedupe key every send uses, so a second press while the first job is
 * still queued is collapsed rather than paid for twice (`content.render-image`
 * is a `short` queue — see `QUEUE_POLICY`). Exported because the web actions
 * send this queue too and must spell the key the same way.
 */
export function renderImageKey(itemId: string): string {
  return `render-image:${itemId}`;
}

/**
 * The job payload, validated here rather than trusted: it arrives from a web
 * action across a queue, and `force` is the field that decides whether money
 * may be spent replacing a picture that already exists.
 */
export const ContentRenderImageJob = z.object({
  organisationId: z.string().uuid(),
  itemId: z.string().uuid(),
  mode: z.enum(["template", "ai", "auto"]).optional(),
  force: z.boolean().optional(),
});
export type ContentRenderImageJob = z.input<typeof ContentRenderImageJob>;

export interface RenderImageDeps {
  readonly db: Db;
  readonly imagegen: ImageGenAdapter;
  readonly logger?: SweepLogger & { info(...args: unknown[]): void };
}

/**
 * One render, for one item.
 *
 * The actor is `system`: what a queue records is the process that did the
 * work, and the press that sent the job is on the sender's own audit trail.
 * A refusal comes back as data — `renderContentImage` never throws one — and
 * is logged rather than re-thrown, because pg-boss would otherwise retry a job
 * whose answer ("this post already has a picture") will not change.
 */
export async function handleContentRenderImage(deps: RenderImageDeps, job: ContentRenderImageJob): Promise<RenderContentImageResult> {
  const v = ContentRenderImageJob.parse(job);
  const logger = deps.logger ?? console;
  const result = await renderContentImage(
    deps.db,
    v.organisationId,
    {
      itemId: v.itemId,
      ...(v.mode !== undefined && { mode: v.mode }),
      ...(v.force !== undefined && { force: v.force }),
      actorKind: "system",
      actorId: QUEUE.contentRenderImage,
    },
    { imagegen: deps.imagegen },
  );
  logger.info({ organisationId: v.organisationId, ...result }, "content render-image");
  return result;
}

/**
 * Approved social posts that are due and still have no picture.
 *
 * Read before `claimDueContent` flips them to `publishing`, because a
 * `publishing` item is refused a render — it is in flight, and its picture is
 * settled. Soft-deleted items are excluded the way every other content query
 * excludes them.
 */
async function dueWithoutImage(db: Db, organisationId: string, now: Date): Promise<{ id: string }[]> {
  return db
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(and(
      eq(schema.contentItems.organisationId, organisationId),
      eq(schema.contentItems.status, "approved"),
      inArray(schema.contentItems.channel, [...BACKFILL_CHANNELS]),
      isNull(schema.contentItems.imageUrl),
      isNotNull(schema.contentItems.scheduledFor),
      lte(schema.contentItems.scheduledFor, now),
      isNull(schema.contentItems.deletedAt),
    ));
}

/**
 * The last chance a post gets to be given a picture: run inside
 * `content.publish-due`, immediately before the claim.
 *
 * **Template mode only, and that is not a default — it is the rule.** Nobody
 * is watching this sweep, and an unattended job that can reach a paid
 * generator is how a month's budget disappears at four in the morning; the
 * branded graphic costs nothing and is what these posts would have had anyway.
 * A person who wants a photograph asks for one in the editor.
 *
 * Every item has its own error boundary and the sweep never throws: a render
 * that fails must not stop the post going out. Instagram is the one channel
 * that cannot publish without an image, and `publishOne` still refuses it with
 * a message a person can act on if this could not draw one.
 */
export async function backfillDueImages(deps: RenderImageDeps, organisationId: string, now: Date): Promise<{ considered: number; rendered: number }> {
  const logger = deps.logger ?? console;
  const items = await dueWithoutImage(deps.db, organisationId, now);
  if (items.length === 0) return { considered: 0, rendered: 0 };

  let rendered = 0;
  await sweep(items, { label: `content image backfill (${organisationId})`, id: (item) => item.id, logger }, async (item) => {
    const result = await renderContentImage(
      deps.db,
      organisationId,
      { itemId: item.id, mode: "template", actorKind: "system", actorId: QUEUE.contentPublishDue },
      { imagegen: deps.imagegen },
    );
    if (result.rendered) rendered += 1;
    else logger.info({ organisationId, itemId: item.id, reason: result.reason }, "content image backfill declined");
  });

  logger.info({ organisationId, considered: items.length, rendered }, "content image backfill");
  return { considered: items.length, rendered };
}
