import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { MAX_ERROR_CHARS, truncate } from "../text.js";
import { WORKER_DOWN_AFTER_MS, WORKER_HEARTBEAT_NAME, ensureHeartbeatRow, heartbeatAge } from "./heartbeat.js";

/** Bookkeeping rows in `system_heartbeats`. */
export const WORKER_DOWN_ALERT_NAME = "worker-down-alert";
export const SYSTEM_ERRORS_NAME = "system-errors";

export const WORKER_DOWN_NOTIFICATION_KIND = "worker.down";
export const SYSTEM_ERROR_NOTIFICATION_KIND = "system.error";

/** One `system.error` per signature per hour. */
export const SYSTEM_ERROR_THROTTLE_MS = 60 * 60_000;
/** Signatures older than this are pruned from the throttle row. */
const SIGNATURE_RETENTION_MS = 24 * 60 * 60_000;

export const CheckWorkerDownInput = z.object({
  now: z.coerce.date().default(() => new Date()),
  downAfterMs: z.number().int().positive().default(WORKER_DOWN_AFTER_MS),
});
export type CheckWorkerDownInput = z.input<typeof CheckWorkerDownInput>;

export interface WorkerStatus {
  /** True when the worker has not checked in for `downAfterMs`, or never has. */
  down: boolean;
  seenAt: Date | null;
  ageMs: number | null;
  /** True when this call raised the `worker.down` notification. */
  notified: boolean;
}

/**
 * What the admin layout asks on every render: is the worker alive? With the
 * heartbeat older than five minutes the owner is told **once per outage** —
 * the alert row remembers the `seenAt` it fired for, and a fresh heartbeat
 * (a new `seenAt`) re-arms it. The claim is one conditional UPDATE, so two
 * dashboards loading at once cannot both notify. A worker that has never
 * checked in (a first deploy) shows the banner but does not notify: there is
 * no outage to compare against yet.
 */
export async function checkWorkerDown(db: Db, organisationId: string, input: CheckWorkerDownInput = {}): Promise<WorkerStatus> {
  const v = CheckWorkerDownInput.parse(input);
  const beat = await heartbeatAge(db, { name: WORKER_HEARTBEAT_NAME, now: v.now });
  if (!beat) return { down: true, seenAt: null, ageMs: null, notified: false };
  if (beat.ageMs < v.downAfterMs) return { down: false, seenAt: beat.seenAt, ageMs: beat.ageMs, notified: false };

  await ensureHeartbeatRow(db, WORKER_DOWN_ALERT_NAME, v.now);
  const forSeenAt = beat.seenAt.toISOString();
  const [claimed] = await db.update(schema.systemHeartbeats)
    .set({
      seenAt: v.now,
      details: sql`coalesce(${schema.systemHeartbeats.details}, '{}'::jsonb) || ${JSON.stringify({ forSeenAt, notifiedAt: v.now.toISOString(), organisationId })}::jsonb`,
      updatedAt: v.now,
    })
    .where(and(
      eq(schema.systemHeartbeats.name, WORKER_DOWN_ALERT_NAME),
      sql`coalesce(${schema.systemHeartbeats.details}->>'forSeenAt', '') <> ${forSeenAt}`,
    ))
    .returning();
  if (!claimed) return { down: true, seenAt: beat.seenAt, ageMs: beat.ageMs, notified: false };

  const minutes = Math.floor(beat.ageMs / 60_000);
  await notifyOwner(db, organisationId, {
    kind: WORKER_DOWN_NOTIFICATION_KIND,
    title: `Background worker has not checked in for ${minutes} minutes`,
    body: "Cron jobs, emails, agent runs and publishing are paused until it is back. Check the worker service in Coolify.",
    link: "/",
  });
  return { down: true, seenAt: beat.seenAt, ageMs: beat.ageMs, notified: true };
}

export const NoteSystemErrorInput = z.object({
  /** Which process saw it. */
  source: z.enum(["worker", "web"]),
  /** What makes two errors "the same": the job name + error class, the route + message, … */
  signature: z.string().min(1).max(200),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
  /** The organisation to tell; omitted, every active organisation's owner is told. */
  organisationId: z.string().uuid().optional(),
  now: z.coerce.date().default(() => new Date()),
});
export type NoteSystemErrorInput = z.input<typeof NoteSystemErrorInput>;

export interface SystemErrorNote {
  /** False when the same signature was announced within the last hour. */
  notified: boolean;
  notifiedOrganisations: string[];
}

function pruneSignatures(signatures: Record<string, unknown>, now: Date): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, at] of Object.entries(signatures)) {
    if (typeof at === "string" && now.getTime() - new Date(at).getTime() < SIGNATURE_RETENTION_MS) kept[key] = at;
  }
  return kept;
}

/**
 * An unhandled error somewhere in the system, turned into a `system.error`
 * notification for the owner — once per signature per hour, however many
 * times it repeats. The throttle lives in the `system-errors` heartbeat row:
 * one conditional UPDATE claims the signature, so concurrent reports of the
 * same error (a job retried five times in a second) produce one alert.
 * Never throws for a bookkeeping failure: an alert about an error must not
 * become a second error.
 */
export async function noteSystemError(db: Db, input: NoteSystemErrorInput): Promise<SystemErrorNote> {
  const v = NoteSystemErrorInput.parse(input);
  const key = `${v.source}:${v.signature}`;
  await ensureHeartbeatRow(db, SYSTEM_ERRORS_NAME, v.now);
  const [current] = await db.select().from(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, SYSTEM_ERRORS_NAME));
  const signatures = pruneSignatures((current?.details["signatures"] as Record<string, unknown> | undefined) ?? {}, v.now);
  const cutoff = new Date(v.now.getTime() - SYSTEM_ERROR_THROTTLE_MS).toISOString();

  const [claimed] = await db.update(schema.systemHeartbeats)
    .set({
      seenAt: v.now,
      details: sql`coalesce(${schema.systemHeartbeats.details}, '{}'::jsonb)
        || jsonb_build_object('signatures', ${JSON.stringify({ ...signatures, [key]: v.now.toISOString() })}::jsonb,
                              'last', ${JSON.stringify({ source: v.source, signature: v.signature, message: truncate(v.message, MAX_ERROR_CHARS), at: v.now.toISOString() })}::jsonb)`,
      updatedAt: v.now,
    })
    .where(and(
      eq(schema.systemHeartbeats.name, SYSTEM_ERRORS_NAME),
      sql`(${schema.systemHeartbeats.details}->'signatures'->>${key}) IS NULL OR (${schema.systemHeartbeats.details}->'signatures'->>${key}) < ${cutoff}`,
    ))
    .returning();
  if (!claimed) return { notified: false, notifiedOrganisations: [] };

  const targets = v.organisationId
    ? [v.organisationId]
    : (await db.select({ id: schema.organisations.id }).from(schema.organisations).where(eq(schema.organisations.status, "active"))).map((o) => o.id);
  const notified: string[] = [];
  for (const organisationId of targets) {
    const row = await notifyOwner(db, organisationId, {
      kind: SYSTEM_ERROR_NOTIFICATION_KIND,
      title: `${v.source === "worker" ? "Worker" : "Web"} error: ${truncate(v.signature, 150)}`,
      body: truncate(v.message, MAX_ERROR_CHARS),
      link: "/settings/system",
    }).catch(() => null);
    if (row) notified.push(organisationId);
  }
  return { notified: true, notifiedOrganisations: notified };
}
