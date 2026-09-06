import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

export type HeartbeatRow = typeof schema.systemHeartbeats.$inferSelect;

/** The worker's own row, written every `WORKER_HEARTBEAT_INTERVAL_MS`. */
export const WORKER_HEARTBEAT_NAME = "worker";
export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;
/** Older than this and the worker is considered down. */
export const WORKER_DOWN_AFTER_MS = 5 * 60_000;

export const RecordHeartbeatInput = z.object({
  name: z.string().min(1).max(100),
  details: z.record(z.string(), z.unknown()).default({}),
  now: z.coerce.date().default(() => new Date()),
});
export type RecordHeartbeatInput = z.input<typeof RecordHeartbeatInput>;

/**
 * "I am alive, and here is what I know." Upserts the named row; `details`
 * replaces what was there (the writer owns its own row). Global — no
 * organisation — see the schema comment.
 */
export async function recordHeartbeat(db: Db, input: RecordHeartbeatInput): Promise<HeartbeatRow> {
  const v = RecordHeartbeatInput.parse(input);
  const [row] = await db.insert(schema.systemHeartbeats)
    .values({ name: v.name, seenAt: v.now, details: v.details })
    .onConflictDoUpdate({
      target: schema.systemHeartbeats.name,
      set: { seenAt: v.now, details: v.details, updatedAt: v.now },
    })
    .returning();
  return row!;
}

export const HeartbeatAgeInput = z.object({
  name: z.string().min(1).max(100),
  now: z.coerce.date().default(() => new Date()),
});
export type HeartbeatAgeInput = z.input<typeof HeartbeatAgeInput>;

export interface HeartbeatAge {
  seenAt: Date;
  ageMs: number;
  details: Record<string, unknown>;
}

/** How long since the named process last checked in, or null when it never has. */
export async function heartbeatAge(db: Db, input: HeartbeatAgeInput): Promise<HeartbeatAge | null> {
  const v = HeartbeatAgeInput.parse(input);
  const [row] = await db.select().from(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, v.name));
  if (!row) return null;
  return { seenAt: row.seenAt, ageMs: Math.max(0, v.now.getTime() - row.seenAt.getTime()), details: row.details };
}

/** Makes sure a bookkeeping row exists without touching one that does. */
export async function ensureHeartbeatRow(db: Db, name: string, seenAt: Date): Promise<void> {
  await db.insert(schema.systemHeartbeats).values({ name, seenAt, details: {} }).onConflictDoNothing({ target: schema.systemHeartbeats.name });
}

/** The heartbeat row's `details` merged with a patch, atomically. */
export async function mergeHeartbeatDetails(db: Db, name: string, patch: Record<string, unknown>, now: Date): Promise<void> {
  await db.update(schema.systemHeartbeats)
    .set({ details: sql`coalesce(${schema.systemHeartbeats.details}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: now })
    .where(eq(schema.systemHeartbeats.name, name));
}
