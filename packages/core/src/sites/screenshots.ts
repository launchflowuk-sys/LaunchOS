import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import {
  MAX_SCREENSHOT_BYTES,
  ScreenshotFailed,
  type ScreenshotAdapter,
} from "@launchos/integrations";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Thumbnails of the sites we host.
 *
 * Telemetry, so none of this writes to `audit_log` — see the note on
 * `site_screenshots`. Every function still takes `organisationId` first and
 * filters on it, because the tenancy rule has no exceptions.
 */

export interface SiteThumbnail {
  readonly siteId: string;
  /** Null when nothing has ever been captured for this site. */
  readonly capturedAt: Date | null;
  readonly adapter: string;
  readonly failureReason: string | null;
  readonly hasImage: boolean;
}

/**
 * The thumbnail state for a set of sites, without the bytes.
 *
 * Deliberately excludes `bytes`: the websites list renders twenty of these and
 * pulling a megabyte of PNG through the page's props to render twenty `<img>`
 * tags that will fetch them separately anyway is pure waste. The image itself
 * comes from `GET /api/websites/[id]/thumbnail`.
 */
export async function siteThumbnails(
  db: Db,
  organisationId: string,
  siteIds: readonly string[],
): Promise<Map<string, SiteThumbnail>> {
  if (siteIds.length === 0) return new Map();
  const rows = await db
    .select({
      siteId: schema.siteScreenshots.siteId,
      capturedAt: schema.siteScreenshots.capturedAt,
      adapter: schema.siteScreenshots.adapter,
      failureReason: schema.siteScreenshots.failureReason,
      // `bytes is not null` rather than the bytes, for the reason above.
      hasImage: sql<boolean>`${schema.siteScreenshots.bytes} is not null`,
    })
    .from(schema.siteScreenshots)
    .where(
      and(
        eq(schema.siteScreenshots.organisationId, organisationId),
        inArray(schema.siteScreenshots.siteId, [...siteIds]),
      ),
    );

  return new Map(rows.map((row) => [row.siteId, { ...row, hasImage: Boolean(row.hasImage) }]));
}

/** The image itself, for the route that serves it. Null when there is nothing to serve. */
export async function readSiteThumbnail(
  db: Db,
  organisationId: string,
  siteId: string,
): Promise<{ bytes: Buffer; mime: string; capturedAt: Date } | null> {
  const [row] = await db
    .select({
      bytes: schema.siteScreenshots.bytes,
      mime: schema.siteScreenshots.mime,
      capturedAt: schema.siteScreenshots.capturedAt,
    })
    .from(schema.siteScreenshots)
    .where(
      and(
        eq(schema.siteScreenshots.organisationId, organisationId),
        eq(schema.siteScreenshots.siteId, siteId),
      ),
    )
    .limit(1);

  if (!row?.bytes || !row.mime || !row.capturedAt) return null;
  return { bytes: row.bytes, mime: row.mime, capturedAt: row.capturedAt };
}

/**
 * The sites most worth photographing next, stalest first.
 *
 * Only `live` and `building` sites: a paused or archived site is not something
 * anyone is looking at, and paying to photograph it every day is spending
 * money to keep a picture of nothing current.
 */
export async function sitesDueForScreenshot(
  db: Db,
  organisationId: string,
  limit = 25,
): Promise<{ id: string; primaryUrl: string }[]> {
  return db
    .select({ id: schema.sites.id, primaryUrl: schema.sites.primaryUrl })
    .from(schema.sites)
    .leftJoin(schema.siteScreenshots, eq(schema.siteScreenshots.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.sites.organisationId, organisationId),
        inArray(schema.sites.status, ["live", "building"]),
      ),
    )
    // Nulls first is the whole point — a site with no row has never been shot,
    // and Postgres puts nulls last on an ascending sort by default. Written as
    // one fragment because the modifier follows the direction: `asc nulls
    // first`, not `nulls first asc`, which is a syntax error.
    .orderBy(sql`${schema.siteScreenshots.attemptedAt} asc nulls first`, desc(schema.sites.createdAt))
    .limit(limit);
}

export interface CaptureResult {
  readonly siteId: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * Photographs one site and stores the result, success or failure.
 *
 * A failure is **recorded, not thrown**. Twenty sites are captured in one job
 * and one unreachable host must not stop the other nineteen; more importantly,
 * "this site could not be photographed" is information the websites list should
 * show rather than swallow — a site that has failed to render for a week is
 * usually a site with a problem.
 *
 * The upsert is on `site_id`, so a capture replaces the previous one. On
 * failure the previous image is deliberately **kept**: yesterday's picture of a
 * site is far more useful than a blank square, and `failure_reason` alongside
 * it says the picture is stale and why.
 */
export async function captureSiteScreenshot(
  db: Db,
  organisationId: string,
  input: { siteId: string; url: string },
  adapter: ScreenshotAdapter,
  now: Date = new Date(),
): Promise<CaptureResult> {
  const failed = async (reason: string): Promise<CaptureResult> => {
    await db
      .insert(schema.siteScreenshots)
      .values({
        organisationId,
        siteId: input.siteId,
        adapter: adapter.name,
        attemptedAt: now,
        failureReason: reason,
        sizeBytes: 0,
      })
      .onConflictDoUpdate({
        target: schema.siteScreenshots.siteId,
        // Only the attempt and the reason: `bytes`, `mime` and `captured_at`
        // are left alone so the last good picture survives a bad day.
        set: { attemptedAt: now, failureReason: reason, adapter: adapter.name, updatedAt: now },
      });
    return { siteId: input.siteId, ok: false, reason };
  };

  let shot: Awaited<ReturnType<ScreenshotAdapter["capture"]>>;
  try {
    shot = await adapter.capture({ url: input.url });
  } catch (error) {
    if (error instanceof ScreenshotFailed) return failed(error.message);
    return failed(error instanceof Error ? error.message : String(error));
  }

  // The adapter contract says it refuses anything larger, but this is the last
  // gate before a blob reaches Postgres and the table's whole design rests on
  // the ceiling holding.
  if (shot.bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return failed(`image is ${shot.bytes.byteLength} bytes, over the ${MAX_SCREENSHOT_BYTES} byte ceiling`);
  }

  const bytes = Buffer.from(shot.bytes);
  await db
    .insert(schema.siteScreenshots)
    .values({
      organisationId,
      siteId: input.siteId,
      bytes,
      mime: shot.mime,
      width: shot.width,
      height: shot.height,
      sizeBytes: bytes.byteLength,
      adapter: shot.adapter,
      capturedAt: now,
      attemptedAt: now,
      failureReason: null,
    })
    .onConflictDoUpdate({
      target: schema.siteScreenshots.siteId,
      set: {
        bytes,
        mime: shot.mime,
        width: shot.width,
        height: shot.height,
        sizeBytes: bytes.byteLength,
        adapter: shot.adapter,
        capturedAt: now,
        attemptedAt: now,
        failureReason: null,
        updatedAt: now,
      },
    });

  return { siteId: input.siteId, ok: true, reason: null };
}
