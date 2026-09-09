import { statfs } from "node:fs/promises";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { ensureHeartbeatRow, heartbeatAge, WORKER_HEARTBEAT_NAME } from "./heartbeat.js";

/**
 * How full the disk is, and telling somebody before it matters.
 *
 * Written on 9 Sep 2026, the morning after `/` reached 100% on the Hetzner box
 * and took down every site on it *and Coolify itself*. Nothing had gone wrong
 * with any deployment: Docker had quietly accumulated 51.7GB of unused images
 * and 6.3GB of build cache from ordinary pushes, and at zero bytes free
 * everything that writes falls over at once — the apps, the proxy's backends,
 * and Postgres, which crashed unclean and came back in recovery mode.
 *
 * The failure gave no warning that anybody saw. There is now a weekly prune on
 * the server, but a cron that stops running is silent in exactly the same way,
 * so this is the half that speaks up: the number rides on the worker's own
 * heartbeat, and crossing a threshold tells the owner once.
 */

/** Comfortable. Above this, say something in the brief. */
export const DISK_WARN_PERCENT = 80;
/** Act today. Above this, the owner is notified. */
export const DISK_CRITICAL_PERCENT = 90;

/** The bookkeeping row remembering which threshold the owner has been told about. */
export const DISK_ALERT_NAME = "disk-space-alert";
export const DISK_LOW_NOTIFICATION_KIND = "system.disk_low";

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/**
 * Measured, not asked for.
 *
 * `statfs` on the container's own root reports the host filesystem it is
 * layered on, which is the number that actually matters — the worker runs on
 * the box that fills up. Reading it from the hosting API instead would mean
 * the warning stops working exactly when the API does, which on the morning
 * this was written was the same moment the disk filled.
 */
export async function readDiskUsage(path = "/"): Promise<DiskUsage | null> {
  try {
    const stats = await statfs(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    // `bavail` — what a non-root process may actually use — rather than `bfree`,
    // which counts the reserve only root can touch and so reads several
    // percent healthier than the disk really is.
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return { totalBytes, freeBytes, usedPercent: Math.round(((totalBytes - freeBytes) / totalBytes) * 100) };
  } catch {
    // A platform without `statfs`, or a path that vanished. The heartbeat must
    // keep beating: a missing disk figure is worth less than a live worker.
    return null;
  }
}

export const CheckDiskSpaceInput = z.object({
  now: z.coerce.date().default(() => new Date()),
  criticalPercent: z.number().int().min(1).max(100).default(DISK_CRITICAL_PERCENT),
});
export type CheckDiskSpaceInput = z.input<typeof CheckDiskSpaceInput>;

export interface DiskStatus {
  usedPercent: number | null;
  freeBytes: number | null;
  /** At or past the warning line — shown in the brief, not notified. */
  warn: boolean;
  /** At or past the critical line. */
  critical: boolean;
  /** True when this call raised the notification. */
  notified: boolean;
}

/** The `disk` object the worker puts on its heartbeat. Parsed defensively: it is untyped jsonb. */
const DiskDetails = z.object({
  usedPercent: z.number(),
  freeBytes: z.number(),
});

/** Reads the figure off the worker's last heartbeat rather than measuring here — web is not on the box. */
export function diskFromHeartbeat(details: Record<string, unknown>): DiskUsage | null {
  const parsed = DiskDetails.safeParse(details["disk"]);
  if (!parsed.success) return null;
  return { totalBytes: 0, freeBytes: parsed.data.freeBytes, usedPercent: parsed.data.usedPercent };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Notifies **once per crossing**, not once per check.
 *
 * The alert row remembers the whole-percent figure it last fired at, and only
 * a *higher* one fires again — so a disk sitting at 91% for a week is one
 * notification, while one climbing 91 → 94 → 97 says so each time it gets
 * worse. Falling back below the line clears the memory, so the next climb is
 * heard afresh. A daily repeat of the same number is how somebody learns to
 * ignore the one that matters.
 */
export async function checkDiskSpace(
  db: Db,
  organisationId: string,
  input: CheckDiskSpaceInput = {},
): Promise<DiskStatus> {
  const v = CheckDiskSpaceInput.parse(input);
  const beat = await heartbeatAge(db, { name: WORKER_HEARTBEAT_NAME, now: v.now });
  const disk = beat ? diskFromHeartbeat(beat.details) : null;
  if (!disk) return { usedPercent: null, freeBytes: null, warn: false, critical: false, notified: false };

  const warn = disk.usedPercent >= DISK_WARN_PERCENT;
  const critical = disk.usedPercent >= v.criticalPercent;
  await ensureHeartbeatRow(db, DISK_ALERT_NAME, v.now);

  if (!critical) {
    // Back under the line: forget what was reported, so a later climb is heard.
    await db.update(schema.systemHeartbeats)
      .set({
        details: sql`coalesce(${schema.systemHeartbeats.details}, '{}'::jsonb) - 'atPercent'`,
        updatedAt: v.now,
      })
      .where(eq(schema.systemHeartbeats.name, DISK_ALERT_NAME));
    return { usedPercent: disk.usedPercent, freeBytes: disk.freeBytes, warn, critical, notified: false };
  }

  // The claim: one conditional UPDATE, so two callers cannot both notify.
  const [claimed] = await db.update(schema.systemHeartbeats)
    .set({
      seenAt: v.now,
      details: sql`coalesce(${schema.systemHeartbeats.details}, '{}'::jsonb) || ${JSON.stringify({
        atPercent: disk.usedPercent,
        notifiedAt: v.now.toISOString(),
        organisationId,
      })}::jsonb`,
      updatedAt: v.now,
    })
    .where(and(
      eq(schema.systemHeartbeats.name, DISK_ALERT_NAME),
      sql`coalesce((${schema.systemHeartbeats.details}->>'atPercent')::int, 0) < ${disk.usedPercent}`,
    ))
    .returning();

  if (!claimed) {
    return { usedPercent: disk.usedPercent, freeBytes: disk.freeBytes, warn, critical, notified: false };
  }

  await notifyOwner(db, organisationId, {
    kind: DISK_LOW_NOTIFICATION_KIND,
    title: `Server disk is ${disk.usedPercent}% full`,
    // Names the command, because at 3am the useful part of an alert is the
    // thing you paste, not the thing you already know.
    body: `${gib(disk.freeBytes)} free. At 100% every site on the box goes down, Coolify included. `
      + "Reclaim with: docker image prune -af && docker builder prune -af",
    link: "/settings/health",
  });

  return { usedPercent: disk.usedPercent, freeBytes: disk.freeBytes, warn, critical, notified: true };
}
