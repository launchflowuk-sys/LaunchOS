import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { FAL_IMAGE_COST_PENCE, OPENAI_IMAGE_COST_PENCE, type ImageGenAdapterName, type ImageGenSize } from "@launchos/integrations";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { londonAt } from "./schedule.js";

/**
 * The money side of AI images: what a picture will cost, what the month has
 * cost so far, and where the line is. Kept apart from the renderer because the
 * one rule that matters here — ask before you spend — is easier to see, and to
 * test, on its own.
 */

/** `content_items.metadata.image` — where a picture records what drew it and what it cost. */
export const IMAGE_METADATA_KEY = "image";

export const IMAGEGEN_MONTHLY_CAP_VARIABLE = "IMAGEGEN_MONTHLY_CAP_PENCE";
/** £20 a month across every client, which at fourpence an image is 500 pictures. */
export const DEFAULT_IMAGEGEN_MONTHLY_CAP_PENCE = 2000;

const CapSchema = z.coerce.number().int().min(0);

/**
 * A malformed cap falls back to the default rather than throwing. The failure
 * we are guarding against is unbounded spend, and the default is bounded; a
 * typo in the environment must not stop every post getting a picture.
 */
export function monthlyCapPence(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = CapSchema.safeParse(env[IMAGEGEN_MONTHLY_CAP_VARIABLE]);
  return parsed.success ? parsed.data : DEFAULT_IMAGEGEN_MONTHLY_CAP_PENCE;
}

/** What one image would cost before it is drawn — the same tables the adapters report from. */
const ESTIMATE_PENCE: Readonly<Record<ImageGenAdapterName, Readonly<Record<ImageGenSize, number>>>> = {
  mock: { "1024x1024": 0, "1024x1536": 0, "1536x1024": 0 },
  openai: OPENAI_IMAGE_COST_PENCE,
  fal: FAL_IMAGE_COST_PENCE,
};

/**
 * The cap is checked against this, not against what came back, so it has to be
 * knowable before the call. The mock costs nothing and can never take a month
 * past its cap, which is exactly right: it spends nothing.
 */
export function estimatePence(adapter: ImageGenAdapterName, size: ImageGenSize): number {
  return ESTIMATE_PENCE[adapter][size];
}

/**
 * What this organisation has spent on generated images in the current
 * Europe/London month.
 *
 * Read off the items themselves rather than a counter, so the sum cannot drift
 * from what was actually drawn. Soft-deleted items are counted: the money went
 * out whether or not the post survived. `generatedAt` is compared as text
 * because we write it with `toISOString()` — a uniform, sortable format — and
 * a cast would turn one bad value in jsonb into an error for the whole query;
 * the digits-only guard on `costPence` is there for the same reason.
 */
export async function imagegenSpentThisMonth(db: Db, organisationId: string, at: Date = new Date()): Promise<number> {
  const [year, month] = at.toLocaleDateString("en-CA", { timeZone: "Europe/London" }).split("-").map(Number) as [number, number];
  const start = londonAt(year, month, 1, 0);
  const end = month === 12 ? londonAt(year + 1, 1, 1, 0) : londonAt(year, month + 1, 1, 0);
  const image = sql`${schema.contentItems.metadata} -> ${IMAGE_METADATA_KEY}`;

  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum((${image} ->> 'costPence')::numeric), 0)` })
    .from(schema.contentItems)
    .where(and(
      eq(schema.contentItems.organisationId, organisationId),
      sql`${image} ->> 'costPence' ~ '^[0-9]+$'`,
      sql`${image} ->> 'generatedAt' >= ${start.toISOString()}`,
      sql`${image} ->> 'generatedAt' < ${end.toISOString()}`,
    ));
  return Number(row?.spent ?? 0);
}
